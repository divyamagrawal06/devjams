import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  fenceProvisionedCandidate,
  reconcileExpiredDeployments,
  reconcilePendingCandidateCleanup,
  restartDisposition,
} from "../src/modules/deploy/controller";
import { DurableDeploymentQueue } from "../src/modules/deploy/queue";
import { type DeploymentRecord, MemoryDeploymentStore } from "../src/modules/deploy/store";
import { MemoryHeadroomStore } from "../src/modules/quota/headroom";
import { MemoryTransferStore, TransferService } from "../src/modules/velocity/transfers";

function deployment(
  id: string,
  overrides: Partial<Omit<DeploymentRecord, "queueSequence">> = {},
): Omit<DeploymentRecord, "queueSequence"> {
  return {
    id,
    serverId: "srv_alpha",
    state: "queued",
    queuePosition: null,
    candidatePod: null,
    snapshotId: null,
    fromVersion: "6",
    toVersion: "7",
    error: null,
    startedAt: "2026-08-30T12:00:00.000Z",
    finishedAt: null,
    userId: "owner",
    namespace: null,
    liveDeployment: null,
    liveService: null,
    approvedContentDigest: `sha256:${"a".repeat(64)}`,
    artifactUrl: null,
    artifactDigest: null,
    artifactRuntimeVersion: null,
    initiatedBy: `mtk_${"b".repeat(32)}`,
    queueStatus: "waiting",
    workerId: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

describe("durable deployment queue and reconciliation", () => {
  test("preserves FIFO position and an active lease across worker recreation", async () => {
    let now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryDeploymentStore(() => now);
    await store.create(deployment("dep_first"));
    await store.create(deployment("dep_second"));

    const firstWorker = new DurableDeploymentQueue(store, {
      workerId: "worker_one",
      maxConcurrent: 1,
      leaseMs: 60_000,
    });
    await expect(firstWorker.claimNext()).resolves.toBe("dep_first");
    await expect(firstWorker.position("dep_first")).resolves.toBe(0);
    await expect(firstWorker.position("dep_second")).resolves.toBe(1);

    now = new Date("2026-08-30T12:00:30.000Z");
    await expect(firstWorker.renew("dep_first")).resolves.toBe(true);
    expect((await store.find("dep_first"))?.leaseExpiresAt).toBe("2026-08-30T12:01:30.000Z");

    const restartedWorker = new DurableDeploymentQueue(store, {
      workerId: "worker_two",
      maxConcurrent: 1,
      leaseMs: 60_000,
    });
    await expect(restartedWorker.claimNext()).resolves.toBeNull();
    expect((await store.find("dep_first"))?.workerId).toBe("worker_one");

    now = new Date("2026-08-30T12:01:30.001Z");
    expect(await store.listRecoverable()).toHaveLength(2);
    await expect(restartedWorker.claimNext()).resolves.toBeNull();
    await expect(firstWorker.renew("dep_first")).resolves.toBe(false);
  });

  test("fills every configured worker slot in durable FIFO order", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_first"));
    await store.create(deployment("dep_second"));
    await store.create(deployment("dep_third"));
    const queue = new DurableDeploymentQueue(store, {
      workerId: "worker_pool",
      maxConcurrent: 2,
      leaseMs: 60_000,
    });

    await expect(queue.claimAvailable()).resolves.toEqual(["dep_first", "dep_second"]);
    await queue.complete("dep_first");
    await expect(queue.claimAvailable()).resolves.toEqual(["dep_third"]);
  });

  test("reclaims an abandoned lease before admitting queued work", async () => {
    let now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryDeploymentStore(() => now);
    await store.create(deployment("dep_abandoned"));
    await store.create(deployment("dep_waiting"));
    const queue = new DurableDeploymentQueue(store, {
      workerId: "worker_recovery",
      maxConcurrent: 1,
      leaseMs: 1_000,
    });
    await expect(queue.claimNext()).resolves.toBe("dep_abandoned");
    await store.transition("dep_abandoned", "staging");

    now = new Date("2026-08-30T12:00:01.001Z");
    const aborted: string[] = [];
    await expect(
      reconcileExpiredDeployments(queue, store, {
        abort: async (id) => {
          expect((await store.find(id))?.workerId).toBe("recovery_worker_recovery");
          await expect(queue.renew(id)).resolves.toBe(false);
          aborted.push(id);
          await store.transition(id, "aborted", {
            queueStatus: "complete",
            workerId: null,
            leaseExpiresAt: null,
          });
        },
        releaseHeadroom: async () => undefined,
      }),
    ).resolves.toEqual(["dep_abandoned"]);
    expect(aborted).toEqual(["dep_abandoned"]);
    await expect(queue.claimAvailable()).resolves.toEqual(["dep_waiting"]);
  });

  test("fences and cleans provisioning that returns after lease recovery", async () => {
    const effects: string[] = [];
    await expect(
      fenceProvisionedCandidate({
        renew: async () => false,
        cleanup: async () => {
          effects.push("candidate deleted");
        },
        recordCleanupRetry: async () => {
          effects.push("cleanup retry recorded");
        },
        releaseHeadroom: async () => {
          effects.push("headroom released");
        },
      }),
    ).resolves.toBe(false);
    expect(effects).toEqual(["candidate deleted", "headroom released"]);
  });

  test("persists and retries candidate cleanup after a transient deletion failure", async () => {
    const effects: string[] = [];
    await expect(
      fenceProvisionedCandidate({
        renew: async () => false,
        cleanup: async () => {
          throw new Error("temporary Kubernetes outage");
        },
        recordCleanupRetry: async () => {
          effects.push("cleanup retry recorded");
        },
        releaseHeadroom: async () => {
          effects.push("headroom released");
        },
      }),
    ).resolves.toBe(false);
    expect(effects).toEqual(["cleanup retry recorded", "headroom released"]);

    const store = new MemoryDeploymentStore();
    await store.create(
      deployment("dep_cleanup", {
        state: "aborted",
        queueStatus: "complete",
        candidatePod: "candidate-b",
        namespace: "fl-owner",
      }),
    );
    let attempts = 0;
    const cleanup = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary Kubernetes outage");
    };
    await expect(
      reconcilePendingCandidateCleanup(store, cleanup, () => undefined),
    ).resolves.toEqual([]);
    expect((await store.find("dep_cleanup"))?.candidatePod).toBe("candidate-b");
    await expect(
      reconcilePendingCandidateCleanup(store, cleanup, () => undefined),
    ).resolves.toEqual(["dep_cleanup"]);
    expect((await store.find("dep_cleanup"))?.candidatePod).toBeNull();
    expect((await store.find("dep_cleanup"))?.namespace).toBeNull();
  });

  test("terminalization never erases a concurrently published cleanup marker", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_race", { state: "staging", queueStatus: "running" }));
    await store.transition("dep_race", "aborted", {
      candidatePod: "candidate-late",
      namespace: "fl-owner",
      queueStatus: "complete",
    });
    await store.transition("dep_race", "aborted", {
      error: "deployment worker lease expired before cutover",
      queueStatus: "complete",
      workerId: null,
      leaseExpiresAt: null,
    });
    expect((await store.find("dep_race"))?.candidatePod).toBe("candidate-late");
    expect((await store.find("dep_race"))?.namespace).toBe("fl-owner");
  });

  test("defines conservative restart actions for every in-flight boundary", () => {
    expect(restartDisposition({ state: "queued", queueStatus: "waiting" })).toBe("resume_queue");
    for (const state of ["building", "staging", "presync", "freezing", "verifying"] as const) {
      expect(restartDisposition({ state, queueStatus: "running" })).toBe("abort_pre_cutover");
    }
    for (const state of ["cutover", "draining"] as const) {
      expect(restartDisposition({ state, queueStatus: "running" })).toBe("preserve_post_cutover");
    }
  });

  test("persists transitions and rollback heads independently of one worker", async () => {
    const store = new MemoryDeploymentStore(() => new Date("2026-08-30T12:00:00.000Z"));
    await store.create(deployment("dep_change"));
    await store.transition("dep_change", "building", {}, "worker admitted");
    await store.transition("dep_change", "verifying", {
      candidatePod: "candidate-b",
      queueStatus: "running",
      workerId: "worker_one",
      leaseExpiresAt: "2026-08-30T12:15:00.000Z",
    });
    await store.commitCutover({
      serverId: "srv_alpha",
      deploymentId: "dep_change",
      version: "7",
      digest: `sha256:${"a".repeat(64)}`,
      workerId: "worker_one",
    });
    await store.create(
      deployment("dep_next", {
        state: "verifying",
        queueStatus: "running",
        workerId: "worker_two",
        leaseExpiresAt: "2026-08-30T12:15:00.000Z",
      }),
    );
    await store.commitCutover({
      serverId: "srv_alpha",
      deploymentId: "dep_next",
      version: "8",
      digest: `sha256:${"c".repeat(64)}`,
      workerId: "worker_two",
    });

    const restartedReader = store;
    expect((await restartedReader.find("dep_change"))?.state).toBe("draining");
    expect((await restartedReader.find("dep_change"))?.candidatePod).toBe("candidate-b");
    expect(await restartedReader.findRuleHead("srv_alpha")).toEqual({
      currentVersion: "8",
      currentDigest: `sha256:${"c".repeat(64)}`,
      previousVersion: "7",
      previousDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(store.events.map((event) => event.state)).toEqual([
      "queued",
      "building",
      "verifying",
      "draining",
      "verifying",
      "draining",
    ]);
  });

  test("does not advance either cutover state or rule head after lease expiry", async () => {
    const store = new MemoryDeploymentStore(() => new Date("2026-08-30T12:00:00.000Z"));
    await store.create(
      deployment("dep_expired", {
        state: "verifying",
        queueStatus: "running",
        workerId: "worker_old",
        leaseExpiresAt: "2026-08-30T12:00:00.000Z",
      }),
    );

    await expect(
      store.commitCutover({
        serverId: "srv_alpha",
        deploymentId: "dep_expired",
        version: "7",
        digest: `sha256:${"a".repeat(64)}`,
        workerId: "worker_old",
      }),
    ).rejects.toThrow(/lost its cutover lease/);
    expect((await store.find("dep_expired"))?.state).toBe("verifying");
    await expect(store.findRuleHead("srv_alpha")).resolves.toBeNull();
  });

  test("makes headroom reservation idempotent and owner-bound", async () => {
    const store = new MemoryHeadroomStore();
    const reservation = {
      deploymentId: "dep_change",
      userId: "owner",
      serverId: "srv_alpha",
    };
    await store.reserve(reservation);
    await store.reserve(reservation);
    await expect(store.countForUser("owner")).resolves.toBe(1);
    await expect(store.reserve({ ...reservation, userId: "someone_else" })).rejects.toThrow(
      /conflicts/,
    );
    await store.release("dep_change");
    await expect(store.countForUser("owner")).resolves.toBe(0);
  });
});

describe("scoped durable Velocity transfers", () => {
  test("moves only the source-realm roster and keeps the wrong-realm count at zero", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryTransferStore();
    const service = new TransferService(store, () => now);
    const id = await service.issue({
      deploymentId: "dep_change",
      fromRoute: "realm-a",
      toRoute: "lobby",
      message: "Brief safety move",
      sourcePlayers: ["Alice", "Bob", "Alice"],
    });

    const [pending] = await service.listPending();
    expect(pending).toMatchObject({
      transferId: id,
      fromRoute: "realm-a",
      toRoute: "lobby",
      players: ["Alice", "Bob"],
      attempt: 1,
    });

    let wrongRealmTransferCount = 0;
    try {
      await service.acknowledge(id, { movedPlayers: ["Mallory"], failures: [] });
      wrongRealmTransferCount += 1;
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(wrongRealmTransferCount).toBe(0);
    expect((await store.find(id))?.ack).toBeNull();

    const ack = { movedPlayers: ["Alice"], failures: [{ player: "Bob", reason: "offline" }] };
    await expect(service.acknowledge(id, ack)).resolves.toEqual(ack);
    await expect(service.acknowledge(id, ack)).resolves.toEqual(ack);
    await expect(service.acknowledge(id, { movedPlayers: ["Bob"], failures: [] })).rejects.toThrow(
      /different content/,
    );

    const restartedService = new TransferService(store, () => now);
    await expect(restartedService.acknowledge(id, ack)).resolves.toEqual(ack);
  });

  test("expires unacknowledged transfers and never redelivers them", async () => {
    let now = new Date("2026-08-30T12:00:00.000Z");
    const store = new MemoryTransferStore();
    const service = new TransferService(store, () => now);
    const id = await service.issue({
      deploymentId: "dep_change",
      fromRoute: "realm-a",
      toRoute: "lobby",
      message: "Brief safety move",
      sourcePlayers: ["Alice"],
      expiresInMs: 1_000,
    });
    now = new Date("2026-08-30T12:00:01.001Z");
    await expect(service.listPending()).resolves.toEqual([]);
    await expect(
      service.acknowledge(id, { movedPlayers: ["Alice"], failures: [] }),
    ).rejects.toThrow(/expired/);
    expect((await store.find(id))?.status).toBe("expired");
  });
});

test("migration persists every formerly volatile control-plane record", () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "db",
      "migrations",
      "0007_durable_deployment_state.sql",
    ),
    "utf8",
  );
  for (const table of [
    "deployments",
    "deployment_state_events",
    "deployment_headroom_reservations",
    "server_rule_heads",
    "velocity_transfers",
  ]) {
    expect(migration).toContain(`CREATE TABLE "${table}"`);
  }
  expect(migration).toContain("deployments_queue_claim_idx");
  expect(migration).toContain("velocity_transfers_pending_idx");
});
