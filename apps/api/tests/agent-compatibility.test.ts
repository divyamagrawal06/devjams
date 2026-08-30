import { describe, expect, test } from "bun:test";
import { agentDraftAttempts } from "@repo/db";
import { getTableColumns } from "drizzle-orm";

import { projectServerSummary, selectPreviewTarget } from "../src/modules/agent/compatibility";

describe("live agent API projections", () => {
  test("server summaries admit unavailable roster truth instead of inventing zero players", () => {
    const summary = projectServerSummary(
      {
        id: "c6b0ec36-9ed4-4eb9-a9cb-b99bc95e1ae8",
        name: "Farlands",
        game: "minecraft",
        currentState: "running",
        desiredState: "running",
        statusMessage: null,
        version: "1.21.4",
        type: "paper",
        cpuCores: "2",
        ramMb: 4096,
        storageGb: 20,
        hostname: null,
        ip: null,
        port: 25565,
        createdAt: new Date("2026-08-30T00:00:00.000Z"),
        updatedAt: new Date("2026-08-30T01:00:00.000Z"),
      },
      "7",
    );

    expect(summary.player_count).toBeNull();
    expect(summary.max_players).toBeNull();
    expect(summary.tps).toBeNull();
    expect(summary.current_version).toBe(7);
    expect(summary.hostname).toBeNull();
  });

  test("deploy preview targets the requested version and rolls back to the live head", () => {
    expect(
      selectPreviewTarget({
        requestedVersion: 5,
        currentVersion: "4",
        previousVersion: "3",
        availableVersions: [3, 4, 5],
      }),
    ).toEqual({ fromVersion: 4, toVersion: 5, rollbackTarget: 4 });
  });

  test("rollback preview resolves only a durable previous version", () => {
    expect(
      selectPreviewTarget({
        currentVersion: "5",
        previousVersion: "4",
        availableVersions: [4, 5],
      }),
    ).toEqual({ fromVersion: 5, toVersion: 4, rollbackTarget: 4 });
    expect(
      selectPreviewTarget({
        currentVersion: "1",
        previousVersion: null,
        availableVersions: [1],
      }),
    ).toBeNull();
  });
});

describe("agent drafting privacy boundary", () => {
  test("durable rate-limit rows contain no prompt or model output", () => {
    expect(Object.keys(getTableColumns(agentDraftAttempts)).sort()).toEqual([
      "createdAt",
      "id",
      "principalId",
      "serverId",
    ]);
  });
});
