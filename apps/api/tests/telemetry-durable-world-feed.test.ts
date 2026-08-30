import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WorldEventsRollup } from "@farlands/contracts";

import { InMemoryRollupStore, summarizeWorldFeed } from "../src/modules/telemetry/index.ts";

const first: WorldEventsRollup = {
  server_id: "srv_7f2",
  window_start: "2026-08-30T00:00:00.000Z",
  window_end: "2026-08-30T00:05:00.000Z",
  metrics: {
    joins: 2,
    leaves: 1,
    deaths: 3,
    blocks_placed: 4,
    blocks_broken: 5,
    chat_messages: 6,
    unique_players: 2,
    mean_session_seconds: 120,
    seconds_in_region: { spawn: 40 },
  },
};

describe("durable privacy-aware telemetry", () => {
  test("reports an honest unavailable state instead of zero activity", () => {
    const feed = summarizeWorldFeed("srv_7f2", "1h", [], new Date("2026-08-30T01:00:00Z"));
    expect(feed.available).toBe(false);
    expect(feed.metrics).toBeNull();
    expect(feed.rollup_windows).toBe(0);
    expect(feed.privacy).toContain("Raw events");
  });

  test("merges closed windows without exposing names or chat content", () => {
    const second: WorldEventsRollup = {
      ...first,
      window_start: first.window_end,
      window_end: "2026-08-30T00:10:00.000Z",
      metrics: {
        ...first.metrics,
        joins: 1,
        unique_players: 1,
        seconds_in_region: { spawn: 20, mine: 30 },
      },
    };
    const feed = summarizeWorldFeed("srv_7f2", "1h", [first, second]);
    expect(feed.available).toBe(true);
    expect(feed.metrics?.joins).toBe(3);
    expect(feed.metrics?.unique_players).toBe(2);
    expect(feed.metrics?.seconds_in_region).toEqual({ spawn: 60, mine: 30 });
    expect(JSON.stringify(feed)).not.toContain("player_name");
    expect(JSON.stringify(feed)).not.toContain("chat_content");
  });

  test("duplicate delivery is idempotent and conflicting evidence is refused", async () => {
    const store = new InMemoryRollupStore();
    await store.put(first);
    await store.put(first);
    expect(await store.list(first.server_id)).toHaveLength(1);
    await expect(store.put({ ...first, metrics: { ...first.metrics, joins: 99 } })).rejects.toThrow(
      "different metrics",
    );
  });

  test("the migration creates only immutable aggregate rows", () => {
    const migration = readFileSync(
      new URL("../../../packages/db/migrations/0012_durable_world_rollups.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "world_events_rollup"');
    expect(migration).toContain("immutable_trigger");
    expect(migration).not.toMatch(/player_name|chat_content|raw_events/);
  });
});
