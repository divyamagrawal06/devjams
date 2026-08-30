import { contentDigest, type RollupMetrics, type WorldEventsRollup } from "@farlands/contracts";
import { telemetryEmitterCursors, worldEventsOpenState, worldEventsRollup } from "@repo/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";

import { db, type TransactionType } from "../../db";
import type {
  DurableIngestReceipt,
  TelemetryBatchMutation,
  TelemetryServerCheckpoint,
  TelemetryStateMutation,
} from "./checkpoint.ts";

export type RollupListOptions = {
  /** Include windows that end at or after this instant. */
  since?: Date;
  /** Bound a reader without changing the ingest retention policy. */
  limit?: number;
};

/**
 * Persistence for closed windows. No method accepts or returns a raw event.
 * That omission is the privacy boundary: individual names exist only in the
 * bounded open-window accumulator and are discarded before `put` is called.
 */
export interface RollupStore {
  put(rollup: WorldEventsRollup): Promise<void>;
  list(serverId: string, options?: RollupListOptions): Promise<readonly WorldEventsRollup[]>;
}

export interface CommitTelemetryBatchInput {
  serverId: string;
  emitterId: string;
  sequence: number;
  payloadDigest: string;
  reduce: (checkpoint: unknown | null) => TelemetryBatchMutation;
}

export interface DurableIngestResult extends DurableIngestReceipt {
  reused: boolean;
}

export interface DurableRollupStore extends RollupStore {
  commitBatch(input: CommitTelemetryBatchInput): Promise<DurableIngestResult>;
  mutateCheckpoint(
    serverId: string,
    reduce: (checkpoint: unknown) => TelemetryStateMutation,
  ): Promise<boolean>;
  checkpointServerIds(): Promise<readonly string[]>;
}

export class TelemetryBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryBatchConflictError";
  }
}

export class TelemetrySequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetrySequenceError";
  }
}

export function isDurableRollupStore(store: RollupStore): store is DurableRollupStore {
  const candidate = store as Partial<DurableRollupStore>;
  return (
    typeof candidate.commitBatch === "function" &&
    typeof candidate.mutateCheckpoint === "function" &&
    typeof candidate.checkpointServerIds === "function"
  );
}

function sameRollup(left: WorldEventsRollup, right: WorldEventsRollup): boolean {
  return (
    left.server_id === right.server_id &&
    left.window_start === right.window_start &&
    left.window_end === right.window_end &&
    contentDigest(left.metrics) === contentDigest(right.metrics)
  );
}

function putInMemory(rows: Map<string, WorldEventsRollup[]>, rollup: WorldEventsRollup): void {
  const existing = rows.get(rollup.server_id) ?? [];
  const duplicate = existing.find(
    (row) => row.window_start === rollup.window_start && row.window_end === rollup.window_end,
  );
  if (duplicate) {
    if (!sameRollup(duplicate, rollup)) {
      throw new Error("A closed telemetry window was redelivered with different metrics");
    }
    return;
  }
  const next = [...existing, rollup];
  next.sort((left, right) => Date.parse(left.window_start) - Date.parse(right.window_start));
  rows.set(rollup.server_id, next);
}

function receiptFrom(value: unknown): DurableIngestReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A telemetry emitter cursor has an invalid outcome");
  }
  const candidate = value as Partial<DurableIngestReceipt>;
  if (
    !Number.isInteger(candidate.accepted) ||
    (candidate.accepted ?? -1) < 0 ||
    !Number.isInteger(candidate.late) ||
    (candidate.late ?? -1) < 0 ||
    !Number.isInteger(candidate.closed) ||
    (candidate.closed ?? -1) < 0
  ) {
    throw new Error("A telemetry emitter cursor has an invalid outcome");
  }
  return {
    accepted: candidate.accepted!,
    late: candidate.late!,
    closed: candidate.closed!,
  };
}

/** Production store. Rollups, checkpoints, and emitter cursors commit atomically. */
export class DrizzleRollupStore implements DurableRollupStore {
  async put(rollup: WorldEventsRollup): Promise<void> {
    await db.transaction((tx) => this.putInTransaction(tx, rollup));
  }

  private async putInTransaction(tx: TransactionType, rollup: WorldEventsRollup): Promise<void> {
    const windowStart = new Date(rollup.window_start);
    const windowEnd = new Date(rollup.window_end);
    const inserted = await tx
      .insert(worldEventsRollup)
      .values({
        serverId: rollup.server_id,
        windowStart,
        windowEnd,
        metrics: rollup.metrics,
      })
      .onConflictDoNothing()
      .returning({ serverId: worldEventsRollup.serverId });
    if (inserted.length === 1) return;

    const [existing] = await tx
      .select()
      .from(worldEventsRollup)
      .where(
        and(
          eq(worldEventsRollup.serverId, rollup.server_id),
          eq(worldEventsRollup.windowStart, windowStart),
          eq(worldEventsRollup.windowEnd, windowEnd),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("A telemetry rollup conflict could not be reconciled");
    const retained: WorldEventsRollup = {
      server_id: existing.serverId,
      window_start: existing.windowStart.toISOString(),
      window_end: existing.windowEnd.toISOString(),
      metrics: existing.metrics as RollupMetrics,
    };
    if (!sameRollup(retained, rollup)) {
      throw new Error("A closed telemetry window was redelivered with different metrics");
    }
  }

  async commitBatch(input: CommitTelemetryBatchInput): Promise<DurableIngestResult> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`telemetry:${input.serverId}`}))`,
      );
      const [cursor] = await tx
        .select()
        .from(telemetryEmitterCursors)
        .where(
          and(
            eq(telemetryEmitterCursors.serverId, input.serverId),
            eq(telemetryEmitterCursors.emitterId, input.emitterId),
          ),
        )
        .limit(1);

      if (cursor) {
        if (input.sequence === cursor.lastSequence) {
          if (input.payloadDigest !== cursor.payloadDigest) {
            throw new TelemetryBatchConflictError(
              "A telemetry sequence was retried with a different payload",
            );
          }
          return { ...receiptFrom(cursor.outcome), reused: true };
        }
        if (input.sequence !== cursor.lastSequence + 1) {
          throw new TelemetrySequenceError("Telemetry batches must be delivered in order");
        }
      } else if (input.sequence !== 1) {
        throw new TelemetrySequenceError("A new telemetry emitter must begin at sequence 1");
      }

      const [stateRow] = await tx
        .select({ checkpoint: worldEventsOpenState.checkpoint })
        .from(worldEventsOpenState)
        .where(eq(worldEventsOpenState.serverId, input.serverId))
        .limit(1);
      const mutation = input.reduce(stateRow?.checkpoint ?? null);
      for (const rollup of mutation.rollups) await this.putInTransaction(tx, rollup);

      const now = new Date();
      await tx
        .insert(worldEventsOpenState)
        .values({
          serverId: input.serverId,
          checkpoint: mutation.checkpoint as unknown as Record<string, unknown>,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: worldEventsOpenState.serverId,
          set: {
            checkpoint: mutation.checkpoint as unknown as Record<string, unknown>,
            updatedAt: now,
          },
        });

      await tx
        .insert(telemetryEmitterCursors)
        .values({
          serverId: input.serverId,
          emitterId: input.emitterId,
          lastSequence: input.sequence,
          payloadDigest: input.payloadDigest,
          outcome: mutation.receipt as unknown as Record<string, unknown>,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [telemetryEmitterCursors.serverId, telemetryEmitterCursors.emitterId],
          set: {
            lastSequence: input.sequence,
            payloadDigest: input.payloadDigest,
            outcome: mutation.receipt as unknown as Record<string, unknown>,
            updatedAt: now,
          },
        });

      return { ...mutation.receipt, reused: false };
    });
  }

  async mutateCheckpoint(
    serverId: string,
    reduce: (checkpoint: unknown) => TelemetryStateMutation,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`telemetry:${serverId}`}))`);
      const [stateRow] = await tx
        .select({ checkpoint: worldEventsOpenState.checkpoint })
        .from(worldEventsOpenState)
        .where(eq(worldEventsOpenState.serverId, serverId))
        .limit(1);
      if (!stateRow) return false;
      const mutation = reduce(stateRow.checkpoint);
      for (const rollup of mutation.rollups) await this.putInTransaction(tx, rollup);
      await tx
        .update(worldEventsOpenState)
        .set({
          checkpoint: mutation.checkpoint as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(worldEventsOpenState.serverId, serverId));
      return true;
    });
  }

  async checkpointServerIds(): Promise<readonly string[]> {
    const rows = await db
      .select({ serverId: worldEventsOpenState.serverId })
      .from(worldEventsOpenState);
    return rows.map((row) => row.serverId);
  }

  async list(
    serverId: string,
    options: RollupListOptions = {},
  ): Promise<readonly WorldEventsRollup[]> {
    const where = and(
      eq(worldEventsRollup.serverId, serverId),
      options.since ? gte(worldEventsRollup.windowEnd, options.since) : undefined,
    );
    const base = db
      .select()
      .from(worldEventsRollup)
      .where(where)
      .orderBy(asc(worldEventsRollup.windowStart));
    const rows = options.limit ? await base.limit(options.limit) : await base;
    return rows.map((row) => ({
      server_id: row.serverId,
      window_start: row.windowStart.toISOString(),
      window_end: row.windowEnd.toISOString(),
      metrics: row.metrics as RollupMetrics,
    }));
  }
}

/** Development/test store with the same transaction, cursor, and checkpoint semantics. */
export class InMemoryRollupStore implements DurableRollupStore {
  private readonly rows = new Map<string, WorldEventsRollup[]>();
  private readonly checkpoints = new Map<string, TelemetryServerCheckpoint>();
  private readonly cursors = new Map<
    string,
    { sequence: number; payloadDigest: string; outcome: DurableIngestReceipt }
  >();
  private transactionTail: Promise<void> = Promise.resolve();

  private async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async put(rollup: WorldEventsRollup): Promise<void> {
    putInMemory(this.rows, rollup);
  }

  async list(
    serverId: string,
    options: RollupListOptions = {},
  ): Promise<readonly WorldEventsRollup[]> {
    const since = options.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rows = (this.rows.get(serverId) ?? []).filter(
      (row) => Date.parse(row.window_end) >= since,
    );
    return options.limit ? rows.slice(0, options.limit) : rows;
  }

  async commitBatch(input: CommitTelemetryBatchInput): Promise<DurableIngestResult> {
    return this.transaction(async () => {
      const cursorKey = `${input.serverId}:${input.emitterId}`;
      const cursor = this.cursors.get(cursorKey);
      if (cursor) {
        if (input.sequence === cursor.sequence) {
          if (input.payloadDigest !== cursor.payloadDigest) {
            throw new TelemetryBatchConflictError(
              "A telemetry sequence was retried with a different payload",
            );
          }
          return { ...cursor.outcome, reused: true };
        }
        if (input.sequence !== cursor.sequence + 1) {
          throw new TelemetrySequenceError("Telemetry batches must be delivered in order");
        }
      } else if (input.sequence !== 1) {
        throw new TelemetrySequenceError("A new telemetry emitter must begin at sequence 1");
      }

      const current = this.checkpoints.get(input.serverId);
      const mutation = input.reduce(current ? structuredClone(current) : null);
      const stagedRows = new Map(
        [...this.rows.entries()].map(([serverId, rows]) => [serverId, [...rows]]),
      );
      for (const rollup of mutation.rollups) putInMemory(stagedRows, rollup);
      this.rows.clear();
      for (const [serverId, rows] of stagedRows) this.rows.set(serverId, rows);
      this.checkpoints.set(input.serverId, structuredClone(mutation.checkpoint));
      this.cursors.set(cursorKey, {
        sequence: input.sequence,
        payloadDigest: input.payloadDigest,
        outcome: structuredClone(mutation.receipt),
      });
      return { ...mutation.receipt, reused: false };
    });
  }

  async mutateCheckpoint(
    serverId: string,
    reduce: (checkpoint: unknown) => TelemetryStateMutation,
  ): Promise<boolean> {
    return this.transaction(async () => {
      const current = this.checkpoints.get(serverId);
      if (!current) return false;
      const mutation = reduce(structuredClone(current));
      const stagedRows = new Map(
        [...this.rows.entries()].map(([storedServerId, rows]) => [storedServerId, [...rows]]),
      );
      for (const rollup of mutation.rollups) putInMemory(stagedRows, rollup);
      this.rows.clear();
      for (const [storedServerId, rows] of stagedRows) this.rows.set(storedServerId, rows);
      this.checkpoints.set(serverId, structuredClone(mutation.checkpoint));
      return true;
    });
  }

  async checkpointServerIds(): Promise<readonly string[]> {
    return [...this.checkpoints.keys()].sort();
  }

  contents(): Record<string, readonly WorldEventsRollup[]> {
    return Object.fromEntries(this.rows);
  }

  checkpointContents(): Record<string, TelemetryServerCheckpoint> {
    return Object.fromEntries(
      [...this.checkpoints.entries()].map(([serverId, checkpoint]) => [
        serverId,
        structuredClone(checkpoint),
      ]),
    );
  }

  clear(): void {
    this.rows.clear();
    this.checkpoints.clear();
    this.cursors.clear();
  }
}
