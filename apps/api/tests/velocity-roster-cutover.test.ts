import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorldSyncScripts } from "../src/modules/provisioning/tenancy";
import { MemoryRouteRosterStore, RouteRosterService } from "../src/modules/velocity/roster";

describe("Velocity route roster truth", () => {
  test("normalizes a fresh source roster and rejects malformed reports", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryRouteRosterStore();
    const service = new RouteRosterService(store, () => now);

    await expect(
      service.report([
        {
          route: " realm-a ",
          targetHost: "SVC-A.EXAMPLE ",
          targetPort: 25565,
          players: [" Bob ", "Alice", "Alice"],
        },
      ]),
    ).resolves.toEqual({ accepted: 1, observedAt: now.toISOString() });
    await expect(service.requireFresh("realm-a")).resolves.toEqual({
      route: "realm-a",
      targetHost: "svc-a.example",
      targetPort: 25565,
      players: ["Alice", "Bob"],
      observedAt: now.toISOString(),
    });

    await expect(
      service.report([{ route: "realm-a", targetHost: "a", targetPort: 0, players: [] }]),
    ).rejects.toThrow(/target port/);
    await expect(
      service.report([
        { route: "realm-a", targetHost: "a", targetPort: 25565, players: [] },
        { route: "realm-a", targetHost: "b", targetPort: 25565, players: [] },
      ]),
    ).rejects.toThrow(/duplicate route/);
  });

  test("fails closed on stale truth and waits for a post-switch target observation", async () => {
    let now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryRouteRosterStore();
    const service = new RouteRosterService(store, () => now);
    await service.report([
      {
        route: "realm-a",
        targetHost: "svc-a.example",
        targetPort: 25565,
        players: ["Alice"],
      },
    ]);

    now = new Date("2026-08-30T12:00:20.001Z");
    await expect(service.requireFresh("realm-a", 20_000)).rejects.toThrow(/stale/);

    const switchedAt = now;
    let waits = 0;
    const result = await service.waitForTarget(
      {
        route: "realm-a",
        targetHost: "svc-b.example",
        targetPort: 25565,
        observedAfter: switchedAt,
        timeoutMs: 1_000,
        intervalMs: 100,
      },
      async (milliseconds) => {
        waits += 1;
        now = new Date(now.getTime() + milliseconds);
        if (waits === 2) {
          await service.report([
            {
              route: "realm-a",
              targetHost: "svc-b.example",
              targetPort: 25565,
              players: [],
            },
          ]);
        }
      },
    );
    expect(result.targetHost).toBe("svc-b.example");
    expect(waits).toBe(2);
  });
});

test("real cutover migration persists every restart and routing checkpoint", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const migration = readFileSync(
    join(root, "packages", "db", "migrations", "0009_real_cutover.sql"),
    "utf8",
  );
  for (const column of [
    "candidate_service",
    "candidate_pvc",
    "source_players",
    "lobby_players",
    "presync_completed_at",
    "saves_disabled",
    "candidate_healthy",
    "route_switched",
    "abort_requested_at",
  ]) {
    expect(migration).toContain('ADD COLUMN "' + column + '"');
  }
  expect(migration).toContain('CREATE TABLE "velocity_route_rosters"');
});

test("freeze protocol has exact save ordering and deletion-aware delta provenance", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const freeze = readFileSync(
    join(root, "apps", "api", "src", "modules", "deploy", "freeze_delta.py"),
    "utf8",
  );
  const tenancy = readFileSync(
    join(root, "apps", "api", "src", "modules", "provisioning", "tenancy.ts"),
    "utf8",
  );
  const cutover = readFileSync(
    join(root, "apps", "api", "src", "modules", "deploy", "cutover.ts"),
    "utf8",
  );
  expect(freeze.indexOf('client.command("save-off")')).toBeLessThan(
    freeze.indexOf('client.command("save-all flush")'),
  );
  expect(freeze.indexOf('client.command("save-all flush")')).toBeLessThan(
    freeze.indexOf('subprocess.run(["python3", "/sync/receiver.py"]'),
  );
  expect(freeze.indexOf('subprocess.run(["python3", "/sync/receiver.py"]')).toBeLessThan(
    freeze.lastIndexOf('client.command("save-on")'),
  );
  expect(tenancy).toContain(".farlands-source-manifest.json");
  expect(tenancy).toContain('query.get("since_ns"');
  expect(tenancy).toContain("metadata.st_mtime_ns <= since_ns");
  expect(tenancy).toContain('response.headers.get("X-Farlands-Snapshot-Started-Ns"');
  expect(cutover).toContain('name: "WORLD_SYNC_SINCE_FILE"');
  expect(cutover).toContain('"/data/.farlands-presync-complete"');
  expect(cutover).not.toContain('checkpoint(row, "presyncCompletedAt")');
  expect(tenancy).toContain("relative not in expected");
  expect(tenancy).toContain('MARKER = os.environ.get("WORLD_SYNC_MARKER")');
  expect(tenancy).toContain('WORLD_SYNC_NAMES = "world,world_nether,world_the_end"');
  expect(tenancy).toContain("archive member is outside managed world roots");
  expect(tenancy).not.toContain("apk add --no-cache tar");
});

test("generated world-sync scripts are valid Python and stay bounded to managed dimensions", () => {
  const scripts = buildWorldSyncScripts();
  for (const [name, source] of Object.entries(scripts)) {
    const compiled = Bun.spawnSync({
      cmd: [
        "python",
        "-c",
        `import sys; compile(sys.stdin.read(), ${JSON.stringify(name + ".py")}, "exec")`,
      ],
      stdin: Buffer.from(source),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(compiled.stderr)).toBe("");
    expect(compiled.exitCode).toBe(0);
  }
  expect(scripts.sender).toContain("for world in NAMES");
  expect(scripts.receiver).toContain("def is_managed(relative)");
  expect(scripts.receiver).toContain("prune(expected)");
  expect(scripts.receiver).not.toContain("os.walk(ROOT");
});
