import { createHmac } from "node:crypto";
import type { WorldEvent, WorldEventsRollup } from "@farlands/contracts";
import {
  EMPTY_TELEMETRY_CHECKPOINT,
  type TelemetryBatchMutation,
  type TelemetryServerCheckpoint,
  type TelemetryStateMutation,
} from "./checkpoint.ts";
import { DEFAULT_MAX_SESSION_SECONDS, SessionLedger } from "./sessions.ts";
import { type DurableIngestResult, isDurableRollupStore, type RollupStore } from "./store.ts";
import { WindowAccumulator } from "./window.ts";

/** Rolling, absolute-time telemetry aggregation with crash-safe checkpoints. */
export const DEFAULT_WINDOW_SECONDS = 300;
export const DEFAULT_STORE_TIMEOUT_MS = 5_000;

export interface AggregatorOptions {
  store: RollupStore;
  windowSeconds?: number;
  maxSessionSeconds?: number;
  storeTimeoutMs?: number;
  onStoreError?: (error: unknown, rollup: WorldEventsRollup) => void;
}

export interface IngestOutcome {
  accepted: number;
  late: number;
  closed: number;
}

export interface DurableIngestInput {
  serverId: string;
  emitterId: string;
  sequence: number;
  payloadDigest: string;
  privacyKey: string;
  events: readonly WorldEvent[];
}

interface ServerState {
  open: WindowAccumulator | null;
  sessions: SessionLedger;
  lastClosedStartMs: number;
}

function validCheckpoint(value: unknown): value is TelemetryServerCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Partial<TelemetryServerCheckpoint>;
  return (
    checkpoint.version === 1 &&
    (checkpoint.last_closed_start_ms === null ||
      (typeof checkpoint.last_closed_start_ms === "number" &&
        Number.isFinite(checkpoint.last_closed_start_ms))) &&
    Array.isArray(checkpoint.sessions) &&
    (checkpoint.open === null || typeof checkpoint.open === "object")
  );
}

export class TelemetryAggregator {
  private readonly store: RollupStore;
  private readonly windowMs: number;
  private readonly maxSessionMs: number;
  private readonly storeTimeoutMs: number;
  private readonly onStoreError: (error: unknown, rollup: WorldEventsRollup) => void;
  /** Legacy synchronous/test states. Production ingest uses durable checkpoints. */
  private readonly servers = new Map<string, ServerState>();
  private writes: Promise<void> = Promise.resolve();
  private droppedWindows = 0;
  private lateEvents = 0;

  constructor(options: AggregatorOptions) {
    this.store = options.store;
    this.windowMs = (options.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
    this.maxSessionMs = (options.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS) * 1000;
    this.storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
    this.onStoreError = options.onStoreError ?? (() => {});
  }

  /**
   * Pure in-memory compatibility seam for rollup unit tests. HTTP ingest uses
   * `ingestDurably`, because acknowledging an uncommitted batch loses it when
   * the API restarts or when the response is lost in transit.
   */
  ingest(serverId: string, events: readonly WorldEvent[]): IngestOutcome {
    const state = this.stateFor(serverId);
    const mutation = this.fold(serverId, state, events);
    this.lateEvents += mutation.receipt.late;
    for (const rollup of mutation.rollups) this.enqueue(rollup);
    return mutation.receipt;
  }

  /** Atomically commits aggregate state, closed rollups, and the retry cursor. */
  async ingestDurably(input: DurableIngestInput): Promise<DurableIngestResult> {
    if (!isDurableRollupStore(this.store)) {
      this.droppedWindows += 1;
      throw new Error("Telemetry ingest requires a durable rollup store");
    }

    const events = input.events.map((event) => ({
      ...event,
      player_name:
        event.player_name === null
          ? null
          : createHmac("sha256", input.privacyKey)
              .update("telemetry-player:v1\0", "utf8")
              .update(input.serverId, "utf8")
              .update("\0", "utf8")
              .update(event.player_name, "utf8")
              .digest("hex"),
    }));

    try {
      const result = await this.withDeadline(
        this.store.commitBatch({
          serverId: input.serverId,
          emitterId: input.emitterId,
          sequence: input.sequence,
          payloadDigest: input.payloadDigest,
          reduce: (checkpoint) => this.fold(input.serverId, this.restore(checkpoint), events),
        }),
      );
      if (!result.reused) this.lateEvents += result.late;
      return result;
    } catch (error) {
      this.droppedWindows += 1;
      throw error;
    }
  }

  /** Force-close open checkpoints, including checkpoints created before restart. */
  async flush(serverId?: string): Promise<void> {
    const legacyIds = serverId === undefined ? [...this.servers.keys()] : [serverId];
    for (const id of legacyIds) {
      const state = this.servers.get(id);
      if (state?.open) {
        const rollup = this.closeWindow(id, state);
        if (rollup) this.enqueue(rollup);
      }
    }
    await this.settled();

    if (!isDurableRollupStore(this.store)) return;
    const ids = serverId === undefined ? await this.store.checkpointServerIds() : [serverId];
    for (const id of ids) await this.mutateDurableState(id, true, Date.now());
  }

  /** Close only absolute windows whose boundary has passed. */
  async flushExpired(nowMs = Date.now()): Promise<void> {
    for (const [id, state] of this.servers) {
      if (state.open && state.open.endMs <= nowMs) {
        const rollup = this.closeWindow(id, state);
        if (rollup) this.enqueue(rollup);
      }
    }
    await this.settled();

    if (!isDurableRollupStore(this.store)) return;
    for (const id of await this.store.checkpointServerIds()) {
      await this.mutateDurableState(id, false, nowMs);
    }
  }

  async settled(): Promise<void> {
    await this.writes;
  }

  get storeFailures(): number {
    return this.droppedWindows;
  }

  get lateDropped(): number {
    return this.lateEvents;
  }

  liveState(): Record<string, { hasOpenWindow: boolean; openSessions: number }> {
    const out: Record<string, { hasOpenWindow: boolean; openSessions: number }> = {};
    for (const [id, state] of this.servers) {
      out[id] = { hasOpenWindow: state.open !== null, openSessions: state.sessions.openCount };
    }
    return out;
  }

  private fold(
    serverId: string,
    state: ServerState,
    events: readonly WorldEvent[],
  ): TelemetryBatchMutation {
    let accepted = 0;
    let late = 0;
    const rollups: WorldEventsRollup[] = [];

    for (const event of events) {
      const startMs = Math.floor(Date.parse(event.ts) / this.windowMs) * this.windowMs;
      if (state.open === null) {
        if (startMs <= state.lastClosedStartMs) {
          late += 1;
          continue;
        }
        state.open = new WindowAccumulator(startMs, startMs + this.windowMs);
      } else if (startMs > state.open.startMs) {
        const rollup = this.closeWindow(serverId, state);
        if (rollup) rollups.push(rollup);
        state.open = new WindowAccumulator(startMs, startMs + this.windowMs);
      } else if (startMs < state.open.startMs) {
        late += 1;
        continue;
      }
      state.open.add(event, state.sessions);
      accepted += 1;
    }

    return {
      checkpoint: this.checkpoint(state),
      rollups,
      receipt: { accepted, late, closed: rollups.length },
    };
  }

  private restore(value: unknown): ServerState {
    const checkpoint = value ?? EMPTY_TELEMETRY_CHECKPOINT;
    if (!validCheckpoint(checkpoint)) throw new Error("Telemetry server checkpoint is invalid");
    return {
      open: checkpoint.open === null ? null : WindowAccumulator.fromCheckpoint(checkpoint.open),
      sessions: SessionLedger.fromCheckpoint(checkpoint.sessions, this.maxSessionMs),
      lastClosedStartMs: checkpoint.last_closed_start_ms ?? Number.NEGATIVE_INFINITY,
    };
  }

  private checkpoint(state: ServerState): TelemetryServerCheckpoint {
    return {
      version: 1,
      open: state.open?.checkpoint() ?? null,
      sessions: state.sessions.checkpoint(),
      last_closed_start_ms:
        state.lastClosedStartMs === Number.NEGATIVE_INFINITY ? null : state.lastClosedStartMs,
    };
  }

  private stateFor(serverId: string): ServerState {
    const existing = this.servers.get(serverId);
    if (existing) return existing;
    const created = this.restore(null);
    this.servers.set(serverId, created);
    return created;
  }

  private closeWindow(serverId: string, state: ServerState): WorldEventsRollup | null {
    const open = state.open;
    if (open === null) return null;
    const rollup: WorldEventsRollup = {
      server_id: serverId,
      window_start: new Date(open.startMs).toISOString(),
      window_end: new Date(open.endMs).toISOString(),
      metrics: open.toMetrics(),
    };
    state.open = null;
    state.lastClosedStartMs = open.startMs;
    state.sessions.prune(open.endMs);
    return rollup;
  }

  private async mutateDurableState(serverId: string, force: boolean, nowMs: number): Promise<void> {
    if (!isDurableRollupStore(this.store)) return;
    await this.withDeadline(
      this.store.mutateCheckpoint(serverId, (checkpoint): TelemetryStateMutation => {
        const state = this.restore(checkpoint);
        const rollups: WorldEventsRollup[] = [];
        if (state.open && (force || state.open.endMs <= nowMs)) {
          const rollup = this.closeWindow(serverId, state);
          if (rollup) rollups.push(rollup);
        }
        return { checkpoint: this.checkpoint(state), rollups };
      }),
    );
  }

  private enqueue(rollup: WorldEventsRollup): void {
    this.writes = this.writes.then(async () => {
      try {
        await this.withDeadline(this.store.put(rollup));
      } catch (error) {
        this.droppedWindows += 1;
        this.onStoreError(error, rollup);
      }
    });
  }

  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("telemetry store did not respond in time")),
            this.storeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
