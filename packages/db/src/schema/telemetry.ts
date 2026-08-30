import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { gameServers } from "./servers";

/**
 * Closed, privacy-minimised telemetry windows.
 *
 * There is deliberately no raw-event table. Player names and chat content
 * never cross this persistence boundary; the only retained value is the
 * aggregate metric object produced by the bounded in-memory accumulator.
 */
export const worldEventsRollup = pgTable(
  "world_events_rollup",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "world_events_rollup_pk",
      columns: [table.serverId, table.windowStart, table.windowEnd],
    }),
    index("world_events_rollup_server_end_idx").on(table.serverId, table.windowEnd),
    check("world_events_rollup_window_check", sql`${table.windowEnd} > ${table.windowStart}`),
  ],
);
