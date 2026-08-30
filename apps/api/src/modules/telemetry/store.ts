import { contentDigest, type RollupMetrics, type WorldEventsRollup } from "@farlands/contracts";
import { worldEventsRollup } from "@repo/db";
import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "../../db";

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

function sameRollup(left: WorldEventsRollup, right: WorldEventsRollup): boolean {
  return (
    left.server_id === right.server_id &&
    left.window_start === right.window_start &&
    left.window_end === right.window_end &&
    contentDigest(left.metrics) === contentDigest(right.metrics)
  );
}

/** Production store. Closed windows are insert-only and duplicate delivery is idempotent. */
export class DrizzleRollupStore implements RollupStore {
  async put(rollup: WorldEventsRollup): Promise<void> {
    const windowStart = new Date(rollup.window_start);
    const windowEnd = new Date(rollup.window_end);
    const inserted = await db
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

    const [existing] = await db
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

/** Development/test store with the same immutable, idempotent semantics. */
export class InMemoryRollupStore implements RollupStore {
  private readonly rows = new Map<string, WorldEventsRollup[]>();

  async put(rollup: WorldEventsRollup): Promise<void> {
    const existing = this.rows.get(rollup.server_id) ?? [];
    const duplicate = existing.find(
      (row) => row.window_start === rollup.window_start && row.window_end === rollup.window_end,
    );
    if (duplicate) {
      if (!sameRollup(duplicate, rollup)) {
        throw new Error("A closed telemetry window was redelivered with different metrics");
      }
      return;
    }
    existing.push(rollup);
    existing.sort((left, right) => Date.parse(left.window_start) - Date.parse(right.window_start));
    this.rows.set(rollup.server_id, existing);
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

  contents(): Record<string, readonly WorldEventsRollup[]> {
    return Object.fromEntries(this.rows);
  }

  clear(): void {
    this.rows.clear();
  }
}
