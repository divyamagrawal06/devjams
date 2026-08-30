import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { describeDocumentChange } from "../src/modules/changes/diff";
import { changesModule } from "../src/modules/changes/http";
import { reviewedDigestFromIfMatch } from "../src/modules/changes/service";
import { canReplayServerEvents, eventStreamModule } from "../src/modules/events/http";
import {
  createDurableEventStream,
  type DurableEventReader,
  type DurableEventRow,
  durableEventFrame,
  parseReplayCursor,
} from "../src/modules/events/service";

describe("connected change review", () => {
  test("renders deterministic human-readable changes", () => {
    expect(
      describeDocumentChange(
        {
          metadata: { minecraftVersion: "1.20.4", pluginName: "Welcome" },
          onPlayerJoin: { privateMessage: "Hello" },
        },
        {
          metadata: { minecraftVersion: "1.20.4", pluginName: "Welcome" },
          onPlayerJoin: { privateMessage: "Welcome back", startingItems: [] },
        },
      ),
    ).toEqual([
      {
        kind: "changed",
        path: "document.onPlayerJoin.privateMessage",
        before: '"Hello"',
        after: '"Welcome back"',
        summary: 'onPlayerJoin.privateMessage will change from "Hello" to "Welcome back".',
      },
      {
        kind: "added",
        path: "document.onPlayerJoin.startingItems",
        before: null,
        after: "[]",
        summary: "onPlayerJoin.startingItems will be added as [].",
      },
    ]);
  });

  test("approval accepts only a strong exact artifact digest precondition", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(reviewedDigestFromIfMatch(digest)).toBe(digest);
    expect(reviewedDigestFromIfMatch(`"${digest}"`)).toBe(digest);
    expect(reviewedDigestFromIfMatch(`W/"${digest}"`)).toBeNull();
    expect(reviewedDigestFromIfMatch("*")).toBeNull();
    expect(reviewedDigestFromIfMatch(undefined)).toBeNull();
  });

  test("draft, approval, rejection and replay routes fail closed without a session", async () => {
    const app = new Elysia().use(changesModule).use(eventStreamModule);
    const requests = [
      new Request("http://localhost/api/changes/"),
      new Request("http://localhost/api/changes/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: "srv_alpha",
          title: "Welcome message",
          rationale: "Make the first join clearer.",
          document: {},
        }),
      }),
      new Request("http://localhost/api/changes/chg_alpha/approve", { method: "POST" }),
      new Request("http://localhost/api/changes/chg_alpha/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Not for this event." }),
      }),
      new Request("http://localhost/api/servers/srv_alpha/events"),
    ];

    for (const request of requests) {
      expect((await app.handle(request)).status).toBe(401);
    }
  });

  test("database protects the exact review identity and review/deployment shape", () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "packages",
        "db",
        "migrations",
        "0010_connected_operations.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("change_envelopes_review_shape_check");
    expect(migration).toContain("change_envelopes_protect_identity");
    expect(migration).toContain('reviewed_artifact_digest" = "artifact_digest');
    expect(migration).toContain("control_plane_events_server_id_idx");
  });

  test("commits approval and the runnable queue record on one database transaction", () => {
    const service = readFileSync(
      join(import.meta.dir, "..", "src", "modules", "changes", "service.ts"),
      "utf8",
    );
    const store = readFileSync(
      join(import.meta.dir, "..", "src", "modules", "deploy", "store.ts"),
      "utf8",
    );

    expect(service).toContain("createDeploymentRecordInTransaction(");
    expect(service).toContain("await admitQueuedDeployments();");
    expect(service).not.toContain("await enqueueDeploy(");
    expect(store).toContain("Inserts the queue row and both receipt streams");
  });
});

describe("durable SSE replay", () => {
  const rows: DurableEventRow[] = [
    {
      id: 41,
      serverId: "srv_alpha",
      type: "change_submitted",
      data: {
        change_id: `chg_${"a".repeat(32)}`,
        title: "Welcome message",
        rule_version: 7,
        content_digest: `sha256:${"b".repeat(64)}`,
        artifact_digest: `sha256:${"c".repeat(64)}`,
      },
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
    },
    {
      id: 44,
      serverId: "srv_alpha",
      type: "deployment_state",
      data: {
        deployment_id: "dep_alpha",
        state: "queued",
        detail: "enqueued",
        queue_position: 1,
      },
      createdAt: new Date("2026-08-30T12:00:01.000Z"),
    },
  ];

  test("validates Last-Event-ID without truncation or coercion", () => {
    expect(parseReplayCursor(undefined)).toBe(0);
    expect(parseReplayCursor("44")).toBe(44);
    expect(() => parseReplayCursor("-1")).toThrow(/non-negative integer/);
    expect(() => parseReplayCursor("44.5")).toThrow(/non-negative integer/);
    expect(() => parseReplayCursor("9007199254740992")).toThrow(/safe range/);
  });

  test("resumes strictly after the acknowledged durable id", async () => {
    const reads: number[] = [];
    const reader: DurableEventReader = {
      async listAfter(_serverId, afterId) {
        reads.push(afterId);
        return rows.filter((row) => row.id > afterId);
      },
    };
    let clock = 0;
    const body = await new Response(
      createDurableEventStream("srv_alpha", 41, {
        reader,
        lifetimeMs: 10,
        pollMs: 0,
        now: () => (clock += 5),
      }),
    ).text();

    expect(reads).toEqual([41]);
    expect(body).toContain("retry: 2000");
    expect(body).not.toContain("id: 41\n");
    expect(body).toContain("id: 44\n");
    expect(body).toContain("event: deployment_state\n");
  });

  test("closes promptly when the request signal aborts", async () => {
    const abort = new AbortController();
    const reader: DurableEventReader = {
      async listAfter() {
        return [];
      },
    };
    const body = new Response(
      createDurableEventStream("srv_alpha", 0, {
        reader,
        signal: abort.signal,
        lifetimeMs: 60_000,
        pollMs: 60_000,
      }),
    ).text();

    abort.abort();

    await expect(body).resolves.toContain("retry: 2000");
  });

  test("serializes the shared envelope and checks ownership at the route seam", async () => {
    const frame = durableEventFrame(rows[0]!);
    expect(frame).toContain("id: 41");
    expect(frame).toContain('"server_id":"srv_alpha"');
    const checks: Array<[string, string]> = [];
    await expect(
      canReplayServerEvents("owner", "srv_alpha", async (userId, serverId) => {
        checks.push([userId, serverId]);
        return userId === "owner" && serverId === "srv_alpha";
      }),
    ).resolves.toBe(true);
    expect(checks).toEqual([["owner", "srv_alpha"]]);
  });
});
