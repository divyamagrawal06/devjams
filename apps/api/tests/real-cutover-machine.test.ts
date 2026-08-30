import { describe, expect, test } from "bun:test";
import type { DeploymentState, VelocityTransferAck } from "@farlands/contracts";

import {
  abortDeploymentWithRuntime,
  type DeploymentMachineRuntime,
  executeDeploymentMachine,
  validateTransferOutcome,
} from "../src/modules/deploy/controller";
import type { DeploymentRecord } from "../src/modules/deploy/store";
import { MemoryDeploymentStore } from "../src/modules/deploy/store";

const DIGEST = "sha256:" + "a".repeat(64);
const OLD_DIGEST = "sha256:" + "c".repeat(64);

function deployment(
  id: string,
  state: DeploymentState = "queued",
  overrides: Partial<Omit<DeploymentRecord, "queueSequence">> = {},
): Omit<DeploymentRecord, "queueSequence"> {
  return {
    id,
    serverId: "srv_alpha",
    state,
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
    livePvc: null,
    liveProxyTarget: null,
    candidateService: null,
    candidatePvc: null,
    sourcePlayers: [],
    lobbyPlayers: [],
    sourcePlayerCount: 0,
    presyncCompletedAt: null,
    savesDisabled: false,
    candidateHealthy: false,
    routeSwitched: false,
    abortRequestedAt: null,
    approvedContentDigest: DIGEST,
    artifactUrl: null,
    artifactDigest: null,
    artifactRuntimeVersion: null,
    initiatedBy: "machine_owner",
    queueStatus: "running",
    workerId: "worker_test",
    leaseExpiresAt: "2026-08-30T12:10:00.000Z",
    ...overrides,
  };
}

class TestRuntime implements DeploymentMachineRuntime {
  readonly calls: string[] = [];
  readonly transfers: Array<{
    fromRoute: string;
    toRoute: string;
    sourcePlayers: string[];
  }> = [];
  waitRouteFailures = 0;
  lobbyMoveFailures = 0;

  constructor(private readonly artifactDigest = DIGEST) {}

  async resolveArtifact() {
    this.calls.push("resolve");
    return {
      ruleVersionId: "rsv_7",
      ruleVersion: 7,
      contentDigest: this.artifactDigest,
      artifactUrl: "s3://reviewed/rules.jar",
      artifactDigest: this.artifactDigest,
      runtimeDigest: "sha256:" + "b".repeat(64),
      runtimeMinecraftVersion: "1.20.4",
      sizeBytes: 1024,
    };
  }

  async verifyArtifact() {
    this.calls.push("verify-artifact");
  }

  async reserveHeadroom() {
    this.calls.push("reserve");
  }

  async releaseHeadroom() {
    this.calls.push("release");
  }

  async provision() {
    this.calls.push("provision");
    return {
      namespace: "fl-owner",
      deploymentName: "deploy-b",
      serviceName: "svc-b",
      pvcName: "pvc-b",
      liveDeploymentName: "deploy-a",
      liveServiceName: "svc-a",
      livePvcName: "pvc-a",
      liveProxyTarget: "svc-a.fl-owner.svc.cluster.local",
    };
  }

  async sourceRoster() {
    this.calls.push("roster");
    return {
      route: "srv_alpha",
      targetHost: "svc-a.fl-owner.svc.cluster.local",
      targetPort: 25565,
      players: ["Bob", "Alice", "Alice"],
      observedAt: "2026-08-30T12:00:00.000Z",
    };
  }

  async movePlayers(input: {
    fromRoute: string;
    toRoute: string;
    sourcePlayers: string[];
  }): Promise<VelocityTransferAck> {
    this.calls.push("move:" + input.fromRoute + "->" + input.toRoute);
    this.transfers.push({
      fromRoute: input.fromRoute,
      toRoute: input.toRoute,
      sourcePlayers: [...input.sourcePlayers],
    });
    if (input.fromRoute === "lobby" && this.lobbyMoveFailures > 0) {
      this.lobbyMoveFailures -= 1;
      const failed = input.sourcePlayers.at(-1);
      return {
        movedPlayers: failed ? input.sourcePlayers.slice(0, -1) : [],
        failures: failed ? [{ player: failed, reason: "connection failed" }] : [],
      };
    }
    return { movedPlayers: [...input.sourcePlayers], failures: [] };
  }

  async stopCandidate() {
    this.calls.push("stop-b");
  }

  async freezeDelta() {
    this.calls.push("freeze-delta");
  }

  async ensureSaveOn() {
    this.calls.push("save-on");
  }

  async cleanupCutover() {
    this.calls.push("cleanup-cutover");
  }

  async startCandidate() {
    this.calls.push("start-b");
  }

  async verifyCandidate() {
    this.calls.push("verify-b");
  }

  async switchRoute(_row: DeploymentRecord, target: "candidate" | "live") {
    this.calls.push("switch:" + target);
    return new Date("2026-08-30T12:00:01.000Z");
  }

  async waitForRoute(_row: DeploymentRecord, target: "candidate" | "live") {
    this.calls.push("wait-route:" + target);
    if (this.waitRouteFailures > 0) {
      this.waitRouteFailures -= 1;
      throw new Error("route observation unavailable");
    }
  }

  async restoreLive() {
    this.calls.push("restore-a");
  }

  async retireLive() {
    this.calls.push("retire-a");
    return "retained-pvc://fl-owner/pvc-a";
  }

  async removeCandidate() {
    this.calls.push("remove-b");
  }

  now() {
    return new Date("2026-08-30T12:00:05.000Z");
  }
}

function expectOrdered(values: string[], expected: string[]): void {
  let cursor = -1;
  for (const value of expected) {
    const next = values.indexOf(value, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("real cutover state machine", () => {
  test("runs A to lobby to verified B, retains A, and records rollback head", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_happy"));
    const runtime = new TestRuntime();

    await executeDeploymentMachine("dep_happy", runtime, store);

    const row = await store.find("dep_happy");
    expect(row).toMatchObject({
      state: "idle",
      routeSwitched: true,
      candidateHealthy: true,
      sourcePlayerCount: 2,
      sourcePlayers: [],
      lobbyPlayers: [],
      snapshotId: "retained-pvc://fl-owner/pvc-a",
      queueStatus: "complete",
    });
    expect(runtime.transfers).toEqual([
      {
        fromRoute: "srv_alpha",
        toRoute: "lobby",
        sourcePlayers: ["Alice", "Bob"],
      },
      {
        fromRoute: "lobby",
        toRoute: "srv_alpha",
        sourcePlayers: ["Alice", "Bob"],
      },
    ]);
    expectOrdered(runtime.calls, [
      "resolve",
      "verify-artifact",
      "reserve",
      "provision",
      "roster",
      "move:srv_alpha->lobby",
      "stop-b",
      "freeze-delta",
      "start-b",
      "verify-b",
      "switch:candidate",
      "wait-route:candidate",
      "move:lobby->srv_alpha",
      "retire-a",
      "release",
    ]);
    expectOrdered(
      store.events.map((event) => event.state),
      [
        "queued",
        "building",
        "staging",
        "presync",
        "freezing",
        "verifying",
        "cutover",
        "draining",
        "idle",
      ],
    );
    expect(await store.findRuleHead("srv_alpha")).toEqual({
      currentVersion: "7",
      currentDigest: DIGEST,
      previousVersion: null,
      previousDigest: null,
    });
  });

  test("resumes safely after a route observation failure without claiming cutover", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_resume"));
    const runtime = new TestRuntime();
    runtime.waitRouteFailures = 1;

    await expect(executeDeploymentMachine("dep_resume", runtime, store)).rejects.toThrow(
      /route observation unavailable/,
    );
    expect(await store.find("dep_resume")).toMatchObject({
      state: "cutover",
      routeSwitched: false,
      lobbyPlayers: ["Alice", "Bob"],
    });

    await executeDeploymentMachine("dep_resume", runtime, store);
    expect(await store.find("dep_resume")).toMatchObject({
      state: "idle",
      routeSwitched: true,
      snapshotId: "retained-pvc://fl-owner/pvc-a",
    });
    expect(runtime.calls.filter((call) => call === "switch:candidate")).toHaveLength(2);
  });

  test("resumes draining idempotently after a backend restart", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(
      deployment("dep_draining", "draining", {
        namespace: "fl-owner",
        liveDeployment: "deploy-a",
        liveService: "svc-a",
        livePvc: "pvc-a",
        liveProxyTarget: "svc-a.fl-owner.svc.cluster.local",
        candidatePod: "deploy-b",
        candidateService: "svc-b",
        candidatePvc: "pvc-b",
        routeSwitched: true,
        candidateHealthy: true,
      }),
    );
    const runtime = new TestRuntime();

    await executeDeploymentMachine("dep_draining", runtime, store);

    expect(await store.find("dep_draining")).toMatchObject({
      state: "idle",
      snapshotId: "retained-pvc://fl-owner/pvc-a",
    });
    expect(runtime.calls).toContain("retire-a");
    expect(runtime.calls).not.toContain("switch:candidate");
  });

  test("retries a partially acknowledged lobby handoff without advancing the rule head", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_partial"));
    const runtime = new TestRuntime();
    runtime.lobbyMoveFailures = 1;

    await expect(executeDeploymentMachine("dep_partial", runtime, store)).rejects.toThrow(
      /source-realm player.*unmoved/,
    );
    expect(await store.find("dep_partial")).toMatchObject({
      state: "cutover",
      routeSwitched: true,
      lobbyPlayers: ["Alice", "Bob"],
    });
    expect(await store.findRuleHead("srv_alpha")).toBeNull();

    await executeDeploymentMachine("dep_partial", runtime, store);
    expect(await store.find("dep_partial")).toMatchObject({ state: "idle", lobbyPlayers: [] });
    expect(await store.findRuleHead("srv_alpha")).toMatchObject({
      currentVersion: "7",
      currentDigest: DIGEST,
    });
  });

  test("runs an immutable prior artifact through the same safe path as a rollback", async () => {
    const store = new MemoryDeploymentStore();
    await store.recordCutover({
      serverId: "srv_alpha",
      deploymentId: "dep_seed",
      version: "6",
      digest: OLD_DIGEST,
    });
    await store.create(deployment("dep_forward"));
    await executeDeploymentMachine("dep_forward", new TestRuntime(), store);
    expect(await store.findRuleHead("srv_alpha")).toEqual({
      currentVersion: "7",
      currentDigest: DIGEST,
      previousVersion: "6",
      previousDigest: OLD_DIGEST,
    });

    await store.create(
      deployment("dep_rollback", "queued", {
        fromVersion: "7",
        toVersion: "6",
        approvedContentDigest: OLD_DIGEST,
      }),
    );
    await executeDeploymentMachine("dep_rollback", new TestRuntime(OLD_DIGEST), store);
    expect(await store.findRuleHead("srv_alpha")).toEqual({
      currentVersion: "6",
      currentDigest: OLD_DIGEST,
      previousVersion: "7",
      previousDigest: DIGEST,
    });
  });
});

describe("abort and transfer invariants", () => {
  test("refuses to advance the rule head to anything except the verified deployment artifact", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(
      deployment("dep_tamper", "cutover", {
        artifactDigest: DIGEST,
        routeSwitched: true,
      }),
    );

    await expect(
      store.commitCutover({
        serverId: "srv_alpha",
        deploymentId: "dep_tamper",
        version: "7",
        digest: OLD_DIGEST,
      }),
    ).rejects.toThrow(/verified artifact exactly/);
    expect(await store.findRuleHead("srv_alpha")).toBeNull();
  });

  for (const state of [
    "queued",
    "building",
    "staging",
    "presync",
    "freezing",
    "verifying",
  ] as const) {
    test("compensates an abort from " + state, async () => {
      const hasCandidate = ["staging", "presync", "freezing", "verifying"].includes(state);
      const playersInLobby = ["freezing", "verifying"].includes(state);
      const store = new MemoryDeploymentStore();
      await store.create(
        deployment("dep_abort_" + state, state, {
          namespace: hasCandidate ? "fl-owner" : null,
          liveDeployment: hasCandidate ? "deploy-a" : null,
          liveService: hasCandidate ? "svc-a" : null,
          livePvc: hasCandidate ? "pvc-a" : null,
          liveProxyTarget: hasCandidate ? "svc-a.fl-owner.svc.cluster.local" : null,
          candidatePod: hasCandidate ? "deploy-b" : null,
          candidateService: hasCandidate ? "svc-b" : null,
          candidatePvc: hasCandidate ? "pvc-b" : null,
          presyncCompletedAt: hasCandidate ? "2026-08-30T12:00:00.000Z" : null,
          sourcePlayers: playersInLobby ? ["Alice"] : [],
          lobbyPlayers: playersInLobby ? ["Alice"] : [],
          savesDisabled: state === "freezing",
        }),
      );
      const runtime = new TestRuntime();

      const result = await abortDeploymentWithRuntime(
        "dep_abort_" + state,
        runtime,
        store,
        "operator abort",
      );

      expect(result).toMatchObject({
        state: "aborted",
        error: "operator abort",
        queueStatus: "complete",
        candidatePod: null,
        sourcePlayers: [],
        lobbyPlayers: [],
        savesDisabled: false,
      });
      if (hasCandidate) expect(runtime.calls).toContain("remove-b");
      if (state === "freezing") expect(runtime.calls).toContain("save-on");
      if (playersInLobby) {
        expect(runtime.transfers.at(-1)).toEqual({
          fromRoute: "lobby",
          toRoute: "srv_alpha",
          sourcePlayers: ["Alice"],
        });
      }
      expect(runtime.calls).not.toContain("retire-a");
    });
  }

  test("post-cutover abort is a no-op and never deletes B or retires A", async () => {
    const store = new MemoryDeploymentStore();
    await store.create(deployment("dep_noop", "cutover", { routeSwitched: true }));
    const runtime = new TestRuntime();

    const result = await abortDeploymentWithRuntime("dep_noop", runtime, store);

    expect(result.state).toBe("cutover");
    expect(runtime.calls).toEqual([]);
  });

  test("rejects missing, duplicate, and wrong-realm transfer accounting", () => {
    expect(() => validateTransferOutcome(["Alice"], { movedPlayers: [], failures: [] })).toThrow(
      /exactly account/,
    );
    expect(() =>
      validateTransferOutcome(["Alice"], {
        movedPlayers: ["Alice"],
        failures: [{ player: "Alice", reason: "duplicate" }],
      }),
    ).toThrow(/more than once/);
    let wrongRealmTransferCount = 0;
    try {
      validateTransferOutcome(["Alice"], { movedPlayers: ["Mallory"], failures: [] });
      wrongRealmTransferCount += 1;
    } catch {
      // Refused before any controller checkpoint can count it as moved.
    }
    expect(wrongRealmTransferCount).toBe(0);
  });
});
