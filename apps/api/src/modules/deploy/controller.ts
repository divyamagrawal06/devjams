import { randomUUID } from "node:crypto";
import type { DeploymentState, DeploymentView, VelocityTransferAck } from "@farlands/contracts";
import { digestsEqual, PRE_CUTOVER_STATES } from "@farlands/contracts";

import {
  deleteCandidate,
  provisionCandidate,
  startPaperOnCandidate,
  stopCandidateForDelta,
  verifyCandidateHealth,
} from "../provisioning/candidate";
import { tenantNamespace } from "../provisioning/tenancy";
import { releaseDeploymentHeadroom, reserveDeploymentHeadroom } from "../quota/headroom";
import { type DeploymentArtifact, RulesService } from "../rules/service";
import { type RouteRoster, routeRosterService } from "../velocity/roster";
import { issueTransfer, waitForAck } from "../velocity/transfers";
import {
  candidateProxyTarget,
  cleanupCutoverResources,
  ensureLiveSavesEnabled,
  freezeAndSyncDelta,
  restoreLiveDeployment,
  retireLiveAndPromoteCandidate,
  routePort,
  switchServerRoute,
} from "./cutover";
import { type DurableDeploymentQueue, deploymentQueue } from "./queue";
import {
  DeploymentInterruptedError,
  type DeploymentPatch,
  type DeploymentRecord,
  type DeploymentStore,
  deploymentStore,
  type RuleHead,
} from "./store";

const nowIso = () => new Date().toISOString();
const LOBBY_ROUTE = "lobby";

type RollbackTargetLookup = (serverId: string) => RuleHead | null | Promise<RuleHead | null>;

export async function rollbackTargetError(
  serverId: string,
  targetVersion: string,
  approvedContentDigest: string,
  lookup: RollbackTargetLookup = (id) => deploymentStore.findRuleHead(id),
): Promise<string | null> {
  const head = await lookup(serverId);
  if (!head?.previousVersion || !head.previousDigest) {
    return "No rollback target recorded for this server";
  }
  if (head.previousVersion !== targetVersion) {
    return "Rollback target does not match the recorded previous version";
  }
  if (!digestsEqual(head.previousDigest, approvedContentDigest)) {
    return "Rollback digest does not match the recorded previous artifact";
  }
  return null;
}

export function assertApprovedArtifactDigest(approvedDigest: string, builtDigest: string): void {
  if (!digestsEqual(approvedDigest, builtDigest)) {
    throw new Error("Built rule artifact digest does not match the human-approved content digest");
  }
}
function deploymentId(): string {
  return "dep_" + randomUUID().replaceAll("-", "");
}

function view(row: DeploymentRecord): DeploymentView {
  return {
    id: row.id,
    serverId: row.serverId,
    state: row.state,
    queuePosition: row.queuePosition,
    candidatePod: row.candidatePod,
    snapshotId: row.snapshotId,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    error: row.error,
    abortRequestedAt: row.abortRequestedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function assertPreCutover(row: DeploymentRecord): void {
  if (!PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
    throw new Error("Cannot abort after cutover (state=" + row.state + ")");
  }
}

function proxyTargetHost(proxyTarget: string): string {
  return proxyTarget.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

function normalizedPlayers(players: string[]): string[] {
  return [...new Set(players.map((player) => player.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export type TransferOutcome = {
  movedPlayers: string[];
  failures: Array<{ player: string; reason: string }>;
};

export function validateTransferOutcome(
  sourcePlayers: string[],
  ack: VelocityTransferAck,
): TransferOutcome {
  const expected = normalizedPlayers(sourcePlayers);
  const moved = normalizedPlayers(ack.movedPlayers);
  const failures = [...ack.failures]
    .map((failure) => ({ player: failure.player.trim(), reason: failure.reason.trim() }))
    .sort((a, b) => a.player.localeCompare(b.player));
  const reported = [...moved, ...failures.map((failure) => failure.player)].sort((a, b) =>
    a.localeCompare(b),
  );

  if (new Set(reported).size !== reported.length) {
    throw new Error("Velocity transfer acknowledgement reports a player more than once");
  }
  if (
    reported.length !== expected.length ||
    reported.some((player, index) => player !== expected[index])
  ) {
    throw new Error(
      "Velocity transfer acknowledgement does not exactly account for the source roster",
    );
  }
  return { movedPlayers: moved, failures };
}

function requireSuccessfulTransfer(outcome: TransferOutcome): void {
  if (outcome.failures.length) {
    throw new Error(
      "Velocity transfer left " +
        outcome.failures.length +
        " source-realm player(s) unmoved; cutover stopped",
    );
  }
}

type Candidate = Awaited<ReturnType<typeof provisionCandidate>>;

export interface DeploymentMachineRuntime {
  resolveArtifact(row: DeploymentRecord): Promise<DeploymentArtifact>;
  verifyArtifact(artifact: DeploymentArtifact): Promise<void>;
  reserveHeadroom(row: DeploymentRecord): Promise<void>;
  releaseHeadroom(deploymentId: string): Promise<void>;
  provision(row: DeploymentRecord, artifact: DeploymentArtifact): Promise<Candidate>;
  sourceRoster(row: DeploymentRecord): Promise<RouteRoster>;
  movePlayers(input: {
    deploymentId: string;
    fromRoute: string;
    toRoute: string;
    message: string;
    sourcePlayers: string[];
  }): Promise<VelocityTransferAck>;
  stopCandidate(row: DeploymentRecord): Promise<void>;
  freezeDelta(row: DeploymentRecord): Promise<void>;
  ensureSaveOn(row: DeploymentRecord): Promise<void>;
  cleanupCutover(row: DeploymentRecord): Promise<void>;
  startCandidate(row: DeploymentRecord): Promise<void>;
  verifyCandidate(row: DeploymentRecord): Promise<void>;
  switchRoute(row: DeploymentRecord, target: "candidate" | "live"): Promise<Date>;
  waitForRoute(row: DeploymentRecord, target: "candidate" | "live", after: Date): Promise<void>;
  restoreLive(row: DeploymentRecord): Promise<void>;
  retireLive(row: DeploymentRecord): Promise<string>;
  removeCandidate(row: DeploymentRecord): Promise<void>;
  now(): Date;
}

const productionRuntime: DeploymentMachineRuntime = {
  resolveArtifact: (row) =>
    RulesService.resolveDeploymentArtifact({
      serverId: row.serverId,
      userId: row.userId,
      ruleSetVersion: row.toVersion ?? "",
    }),
  verifyArtifact: (artifact) => RulesService.verifyDeploymentArtifact(artifact),
  reserveHeadroom: (row) => reserveDeploymentHeadroom(row.userId, row.serverId, row.id),
  releaseHeadroom: (id) => releaseDeploymentHeadroom(id),
  provision: (row, artifact) =>
    provisionCandidate({
      liveServerId: row.serverId,
      deploymentId: row.id,
      artifactUrl: artifact.artifactUrl,
      artifactDigest: artifact.artifactDigest,
      artifactRuntimeVersion: artifact.runtimeMinecraftVersion,
    }),
  async sourceRoster(row) {
    const roster = await routeRosterService.requireFresh(row.serverId, 10_000);
    if (!row.liveProxyTarget) throw new Error("Deployment is missing the original route target");
    if (
      proxyTargetHost(roster.targetHost) !== proxyTargetHost(row.liveProxyTarget) ||
      roster.targetPort !== routePort()
    ) {
      throw new Error("Velocity source route no longer points at authoritative server A");
    }
    return roster;
  },
  async movePlayers(input) {
    if (!input.sourcePlayers.length) return { movedPlayers: [], failures: [] };
    const transferId = await issueTransfer(input);
    return waitForAck(transferId, 90_000);
  },
  stopCandidate: (row) => stopCandidateForDelta(row.namespace ?? "", row.candidatePod ?? ""),
  freezeDelta: (row) => freezeAndSyncDelta(row),
  ensureSaveOn: (row) => ensureLiveSavesEnabled(row),
  cleanupCutover: (row) => cleanupCutoverResources(row),
  startCandidate: (row) => startPaperOnCandidate(row.namespace ?? "", row.candidatePod ?? ""),
  async verifyCandidate(row) {
    if (!row.artifactDigest) throw new Error("Deployment is missing artifact digest");
    await verifyCandidateHealth({
      namespace: row.namespace ?? "",
      deploymentName: row.candidatePod ?? "",
      deploymentId: row.id,
      artifactDigest: row.artifactDigest,
    });
  },
  switchRoute(row, target) {
    const proxyTarget = target === "candidate" ? candidateProxyTarget(row) : row.liveProxyTarget;
    if (!proxyTarget) throw new Error("Deployment is missing a route target");
    return switchServerRoute(row.serverId, proxyTarget);
  },
  async waitForRoute(row, target, after) {
    const targetHost = target === "candidate" ? candidateProxyTarget(row) : row.liveProxyTarget;
    if (!targetHost) throw new Error("Deployment is missing a route target");
    await routeRosterService.waitForTarget({
      route: row.serverId,
      targetHost: proxyTargetHost(targetHost),
      targetPort: routePort(),
      observedAfter: after,
      timeoutMs: 60_000,
      intervalMs: 250,
    });
  },
  restoreLive: (row) => restoreLiveDeployment(row),
  retireLive: (row) => retireLiveAndPromoteCandidate(row),
  async removeCandidate(row) {
    await deleteCandidate({
      namespace: row.namespace ?? tenantNamespace(row.userId),
      deploymentName: row.candidatePod ?? "candidate-not-yet-checkpointed",
      liveServerId: row.serverId,
      deploymentId: row.id,
    });
  },
  now: () => new Date(),
};

async function machineTransition(
  store: DeploymentStore,
  id: string,
  state: DeploymentState,
  patch: DeploymentPatch,
  detail: string,
  expectedStates: readonly DeploymentState[],
  allowAbortRequested = false,
): Promise<DeploymentRecord> {
  if (store === deploymentStore) {
    const current = await store.find(id);
    if (current?.queueStatus === "running") {
      if (current.workerId !== deploymentQueue.workerId || !(await deploymentQueue.renew(id))) {
        throw new LeaseLostError(id);
      }
    }
  }
  return store.transition(id, state, patch, detail, expectedStates, allowAbortRequested);
}

async function moveAndCheckpointLobby(
  row: DeploymentRecord,
  runtime: DeploymentMachineRuntime,
  store: DeploymentStore,
): Promise<DeploymentRecord> {
  const liability = await machineTransition(
    store,
    row.id,
    "freezing",
    { lobbyPlayers: row.sourcePlayers },
    "source roster durably marked as a lobby-transfer recovery liability",
    ["freezing"],
  );
  const ack = await runtime.movePlayers({
    deploymentId: liability.id,
    fromRoute: liability.serverId,
    toRoute: LOBBY_ROUTE,
    message: "Brief safety move while the reviewed world change is prepared",
    sourcePlayers: liability.sourcePlayers,
  });
  const outcome = validateTransferOutcome(liability.sourcePlayers, ack);
  const checkpointed = await machineTransition(
    store,
    liability.id,
    "freezing",
    { lobbyPlayers: outcome.movedPlayers },
    "source roster moved to lobby; usernames retained only for recovery",
    ["freezing"],
    true,
  );
  if (checkpointed.abortRequestedAt) {
    throw new DeploymentInterruptedError(liability.id, checkpointed.state);
  }
  requireSuccessfulTransfer(outcome);
  return checkpointed;
}

async function runPostCutover(
  id: string,
  runtime: DeploymentMachineRuntime,
  store: DeploymentStore,
  workerId: string,
): Promise<void> {
  let row = await store.find(id);
  if (!row) throw new Error("Deployment not found");

  if (row.state === "cutover") {
    if (!row.routeSwitched) {
      const switchedAt = await runtime.switchRoute(row, "candidate");
      await runtime.waitForRoute(row, "candidate", switchedAt);
      row = await machineTransition(
        store,
        id,
        "cutover",
        { routeSwitched: true },
        "Velocity confirmed the stable route points to candidate B",
        ["cutover"],
      );
    }

    const ack = await runtime.movePlayers({
      deploymentId: row.id,
      fromRoute: LOBBY_ROUTE,
      toRoute: row.serverId,
      message: "Joining the verified replacement server",
      sourcePlayers: row.lobbyPlayers,
    });
    const outcome = validateTransferOutcome(row.lobbyPlayers, ack);
    requireSuccessfulTransfer(outcome);
    row = await machineTransition(
      store,
      id,
      "cutover",
      { lobbyPlayers: [] },
      "exact lobby roster moved to candidate B",
      ["cutover"],
    );

    if (!row.toVersion) throw new Error("Deployment is missing the target version");
    row = await store.commitCutover({
      serverId: row.serverId,
      deploymentId: row.id,
      version: row.toVersion,
      digest: row.approvedContentDigest,
      workerId,
    });
  }

  if (row.state !== "draining") {
    if (row.state === "idle") return;
    throw new Error("Post-cutover reconciliation requires cutover or draining state");
  }

  const snapshotId = await runtime.retireLive(row);
  row = await machineTransition(
    store,
    id,
    "draining",
    { snapshotId },
    "server A scaled to zero and its PVC retained",
    ["draining"],
  );
  await runtime.cleanupCutover(row);
  await runtime.releaseHeadroom(id);
  await machineTransition(
    store,
    id,
    "idle",
    {
      snapshotId,
      sourcePlayers: [],
      lobbyPlayers: [],
      savesDisabled: false,
      finishedAt: runtime.now().toISOString(),
      queueStatus: "complete",
      workerId: null,
      leaseExpiresAt: null,
    },
    "deployment completed with a retained rollback checkpoint",
    ["draining"],
  );
}

export async function executeDeploymentMachine(
  id: string,
  runtime: DeploymentMachineRuntime = productionRuntime,
  store: DeploymentStore = deploymentStore,
  workerId?: string,
  renewLease?: () => Promise<boolean>,
): Promise<void> {
  let row = await store.find(id);
  if (!row) throw new Error("Deployment not found");
  const leaseOwner = workerId ?? row.workerId;
  if (!leaseOwner) throw new Error("Deployment is missing its durable queue owner");
  if (row.state === "cutover" || row.state === "draining") {
    await runPostCutover(id, runtime, store, leaseOwner);
    return;
  }
  if (row.queueStatus !== "running" || row.state !== "queued") return;

  row = await machineTransition(store, id, "building", {}, "building reviewed artifact", [
    "queued",
  ]);
  const artifact = await runtime.resolveArtifact(row);
  assertApprovedArtifactDigest(row.approvedContentDigest, artifact.artifactDigest);
  await runtime.verifyArtifact(artifact);
  row = await machineTransition(
    store,
    id,
    "building",
    {
      artifactUrl: artifact.artifactUrl,
      artifactDigest: artifact.artifactDigest,
      artifactRuntimeVersion: artifact.runtimeMinecraftVersion,
    },
    "verified immutable artifact " + artifact.artifactDigest,
    ["building"],
  );

  row = await machineTransition(
    store,
    id,
    "staging",
    { presyncCompletedAt: runtime.now().toISOString() },
    "recorded the pre-sync lower bound and reserved candidate headroom",
    ["building"],
  );
  await runtime.reserveHeadroom(row);
  const candidate = await runtime.provision(row, artifact);
  const provisionedRow: DeploymentRecord = {
    ...row,
    candidatePod: candidate.deploymentName,
    candidateService: candidate.serviceName,
    candidatePvc: candidate.pvcName,
    namespace: candidate.namespace,
    liveDeployment: candidate.liveDeploymentName,
    liveService: candidate.liveServiceName,
    livePvc: candidate.livePvcName,
    liveProxyTarget: candidate.liveProxyTarget,
  };
  if (renewLease) {
    const retained = await fenceProvisionedCandidate({
      renew: renewLease,
      cleanup: () => runtime.removeCandidate(provisionedRow),
      recordCleanupRetry: async (error) => {
        const current = await store.find(id);
        if (!current) return;
        await store.transition(
          id,
          current.state,
          {
            candidatePod: candidate.deploymentName,
            candidateService: candidate.serviceName,
            candidatePvc: candidate.pvcName,
            namespace: candidate.namespace,
            error: `candidate cleanup pending: ${errorMessage(error)}`,
          },
          "candidate cleanup persisted for retry after lease loss",
          [current.state],
          true,
        );
      },
      releaseHeadroom: () => runtime.releaseHeadroom(id),
    });
    if (!retained) return;
  }
  row = await machineTransition(
    store,
    id,
    "staging",
    {
      candidatePod: candidate.deploymentName,
      candidateService: candidate.serviceName,
      candidatePvc: candidate.pvcName,
      namespace: candidate.namespace,
      liveDeployment: candidate.liveDeploymentName,
      liveService: candidate.liveServiceName,
      livePvc: candidate.livePvcName,
      liveProxyTarget: candidate.liveProxyTarget,
    },
    "candidate B provisioned in held state after pre-sync",
    ["staging"],
  );

  row = await machineTransition(
    store,
    id,
    "presync",
    {},
    "candidate pre-sync completed from the durable lower bound; A remains authoritative",
    ["staging"],
  );

  const roster = await runtime.sourceRoster(row);
  const sourcePlayers = normalizedPlayers(roster.players);
  row = await machineTransition(
    store,
    id,
    "freezing",
    {
      sourcePlayers,
      sourcePlayerCount: sourcePlayers.length,
    },
    "captured a fresh source-route roster",
    ["presync"],
  );
  row = await moveAndCheckpointLobby(row, runtime, store);

  await runtime.stopCandidate(row);
  row = await machineTransition(
    store,
    id,
    "freezing",
    { savesDisabled: true },
    "candidate volume detached; starting bounded freeze and delta",
    ["freezing"],
  );
  await runtime.freezeDelta(row);
  row = await machineTransition(
    store,
    id,
    "freezing",
    { savesDisabled: false },
    "save-on confirmed after manifest-aware delta sync",
    ["freezing"],
    true,
  );
  if (row.abortRequestedAt) throw new DeploymentInterruptedError(row.id, row.state);

  await runtime.cleanupCutover(row);
  await runtime.startCandidate(row);
  await runtime.verifyCandidate(row);
  row = await machineTransition(
    store,
    id,
    "verifying",
    { candidateHealthy: true },
    "candidate passed readiness, artifact, plugin, and startup-log predicates",
    ["freezing"],
  );

  row = await machineTransition(
    store,
    id,
    "cutover",
    {},
    "candidate verified; entering non-abortable route cutover",
    ["verifying"],
  );
  await runPostCutover(row.id, runtime, store, leaseOwner);
}

async function compensatePreCutover(
  id: string,
  error: string,
  runtime: DeploymentMachineRuntime,
  store: DeploymentStore,
): Promise<DeploymentRecord> {
  let row = await store.find(id);
  if (!row) throw new Error("Deployment not found");
  assertPreCutover(row);

  if (row.savesDisabled) {
    await runtime.cleanupCutover(row);
    await runtime.ensureSaveOn(row);
    row = await machineTransition(
      store,
      id,
      row.state,
      { savesDisabled: false },
      "save-on recovery confirmed during abort",
      [row.state],
      true,
    );
  }

  if (row.routeSwitched) {
    await runtime.restoreLive(row);
    const switchedAt = await runtime.switchRoute(row, "live");
    await runtime.waitForRoute(row, "live", switchedAt);
    row = await machineTransition(
      store,
      id,
      row.state,
      { routeSwitched: false },
      "restored route to authoritative server A",
      [row.state],
      true,
    );
  }

  if (row.lobbyPlayers.length) {
    const pendingAck = await runtime.movePlayers({
      deploymentId: row.id,
      fromRoute: row.serverId,
      toRoute: LOBBY_ROUTE,
      message: "Brief safety move while the reviewed world change is prepared",
      sourcePlayers: row.sourcePlayers,
    });
    const pendingOutcome = validateTransferOutcome(row.sourcePlayers, pendingAck);
    row = await machineTransition(
      store,
      id,
      row.state,
      { lobbyPlayers: pendingOutcome.movedPlayers },
      "settled the durable source-to-lobby instruction before compensation",
      [row.state],
      true,
    );
  }

  if (row.lobbyPlayers.length) {
    const ack = await runtime.movePlayers({
      deploymentId: row.id,
      fromRoute: LOBBY_ROUTE,
      toRoute: row.serverId,
      message: "Returning to the unchanged server after a safe abort",
      sourcePlayers: row.lobbyPlayers,
    });
    const outcome = validateTransferOutcome(row.lobbyPlayers, ack);
    row = await machineTransition(
      store,
      id,
      row.state,
      { lobbyPlayers: outcome.failures.map((failure) => failure.player) },
      "all still-connected recovery players accounted for",
      [row.state],
      true,
    );
    requireSuccessfulTransfer(outcome);
  }

  await runtime.cleanupCutover(row);
  await runtime.removeCandidate(row);
  await runtime.releaseHeadroom(id);
  return machineTransition(
    store,
    id,
    "aborted",
    {
      error,
      finishedAt: runtime.now().toISOString(),
      candidatePod: null,
      candidateService: null,
      candidatePvc: null,
      sourcePlayers: [],
      lobbyPlayers: [],
      savesDisabled: false,
      queueStatus: "complete",
      workerId: null,
      leaseExpiresAt: null,
    },
    error,
    PRE_CUTOVER_STATES,
    true,
  );
}

async function requestAndCompensate(
  id: string,
  error: string,
  runtime = productionRuntime,
  store = deploymentStore,
): Promise<DeploymentRecord> {
  const requested = await store.requestAbort(id, runtime.now());
  if (!requested) throw new Error("Deployment not found");
  if (
    requested.state === "idle" ||
    requested.state === "aborted" ||
    requested.state === "failed" ||
    requested.state === "cutover" ||
    requested.state === "draining"
  ) {
    return requested;
  }
  return compensatePreCutover(id, error, runtime, store);
}

type ExpiredRecoveryActions = {
  abort(id: string, reason: string): Promise<void>;
  releaseHeadroom(id: string): Promise<void>;
};

type ProvisionedCandidateFence = {
  renew(): Promise<boolean>;
  cleanup(): Promise<void>;
  recordCleanupRetry(error: unknown): Promise<void>;
  releaseHeadroom(): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fenceProvisionedCandidate(
  actions: ProvisionedCandidateFence,
): Promise<boolean> {
  if (await actions.renew()) return true;
  try {
    try {
      await actions.cleanup();
    } catch (error) {
      await actions.recordCleanupRetry(error);
    }
  } finally {
    await actions.releaseHeadroom();
  }
  return false;
}

export async function reconcilePendingCandidateCleanup(
  store: DeploymentStore = deploymentStore,
  cleanup: (row: DeploymentRecord) => Promise<void> = async (row) => {
    if (!row.namespace || !row.candidatePod) return;
    await deleteCandidate({
      namespace: row.namespace,
      deploymentName: row.candidatePod,
      liveServerId: row.serverId,
      deploymentId: row.id,
    });
  },
  reportError: (row: DeploymentRecord, error: unknown) => void = (row, error) => {
    console.error(`[deploy ${row.id}] candidate cleanup retry failed`, error);
  },
): Promise<string[]> {
  const cleaned: string[] = [];
  for (const row of await store.listPendingCandidateCleanup()) {
    try {
      await cleanup(row);
      await store.transition(
        row.id,
        row.state,
        {
          candidatePod: null,
          candidateService: null,
          candidatePvc: null,
          namespace: null,
          error: "candidate resources cleaned after lease loss",
        },
        "completed durable candidate cleanup retry",
        [row.state],
        true,
      );
      cleaned.push(row.id);
    } catch (error) {
      reportError(row, error);
    }
  }
  return cleaned;
}

export async function reconcileExpiredDeployments(
  claimer: Pick<DurableDeploymentQueue, "claimExpired"> = deploymentQueue,
  store: DeploymentStore = deploymentStore,
  actions: ExpiredRecoveryActions = {
    abort: async (id, reason) => {
      await requestAndCompensate(id, reason, productionRuntime, store);
    },
    releaseHeadroom: releaseDeploymentHeadroom,
  },
): Promise<string[]> {
  const reclaimed: string[] = [];
  while (true) {
    const row = await claimer.claimExpired();
    if (!row) break;
    const disposition = restartDisposition(row);
    if (disposition === "abort_pre_cutover") {
      await actions.abort(row.id, "deployment worker lease expired before cutover");
      reclaimed.push(row.id);
      continue;
    }
    if (row.state === "draining") {
      await store.transition(
        row.id,
        "idle",
        {
          finishedAt: nowIso(),
          queueStatus: "complete",
          workerId: null,
          leaseExpiresAt: null,
        },
        "finished committed cutover after worker lease expiry",
        ["draining"],
        true,
      );
      await actions.releaseHeadroom(row.id);
      reclaimed.push(row.id);
    }
  }
  return reclaimed;
}

class LeaseLostError extends Error {
  constructor(
    readonly deploymentId: string,
    cause?: unknown,
  ) {
    super(`Deployment ${deploymentId} lost its durable queue lease`, { cause });
    this.name = "LeaseLostError";
  }
}

export async function withLeaseHeartbeat<T>(
  id: string,
  operation: () => Promise<T>,
  queue: Pick<DurableDeploymentQueue, "renew" | "heartbeatIntervalMs"> = deploymentQueue,
): Promise<T> {
  let leaseLost = false;
  let leaseFailure: unknown;
  let renewing = false;
  const renew = async () => {
    if (renewing) return;
    renewing = true;
    try {
      if (!(await queue.renew(id))) leaseLost = true;
    } catch (error) {
      leaseLost = true;
      leaseFailure = error;
    } finally {
      renewing = false;
    }
  };
  await renew();
  if (leaseLost) throw new LeaseLostError(id, leaseFailure);
  const timer = setInterval(() => {
    void renew();
  }, queue.heartbeatIntervalMs);
  timer.unref?.();
  try {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      if (leaseLost) throw new LeaseLostError(id, leaseFailure ?? error);
      throw error;
    }
    if (leaseLost) throw new LeaseLostError(id, leaseFailure);
    return result;
  } finally {
    clearInterval(timer);
  }
}

const activeMachines = new Set<string>();

function startMachine(id: string): void {
  if (activeMachines.has(id)) return;
  activeMachines.add(id);
  void withLeaseHeartbeat(id, () =>
    executeDeploymentMachine(id, productionRuntime, deploymentStore, deploymentQueue.workerId, () =>
      deploymentQueue.renew(id),
    ),
  )
    .then(() => {
      activeMachines.delete(id);
      return startNext();
    })
    .catch(async (error) => {
      console.error("[deploy " + id + "] machine failed", error);
      if (error instanceof LeaseLostError) {
        activeMachines.delete(id);
        scheduleReconcileAt(Date.now() + 1_000);
        return;
      }
      const row = await deploymentStore.find(id);
      if (!row) {
        activeMachines.delete(id);
        return;
      }
      if (PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
        try {
          await requestAndCompensate(id, error instanceof Error ? error.message : String(error));
          activeMachines.delete(id);
          await startNext();
        } catch (abortError) {
          activeMachines.delete(id);
          console.error(
            "[deploy " + id + "] compensation failed; reconciliation will retry",
            abortError,
          );
          scheduleReconcileAt(Date.now() + 15_000);
        }
        return;
      }
      try {
        await deploymentStore.transition(
          id,
          row.state,
          { error: error instanceof Error ? error.message : String(error) },
          "post-cutover reconciliation paused after an operational failure",
          [row.state],
          true,
        );
        scheduleReconcileAt(Date.now() + 15_000);
      } catch (recordError) {
        console.error("[deploy " + id + "] failed to persist reconciliation error", recordError);
        scheduleReconcileAt(Date.now() + 15_000);
      } finally {
        activeMachines.delete(id);
      }
    });
}

async function startNext(): Promise<void> {
  for (const admitted of await deploymentQueue.claimAvailable()) startMachine(admitted);
}

export async function getDeployment(id: string): Promise<DeploymentView | null> {
  const row = await deploymentStore.find(id);
  return row ? view(row) : null;
}

export async function enqueueDeploy(input: {
  serverId: string;
  ruleSetVersion: string;
  approvedContentDigest: string;
  initiatedBy: string;
  userId: string;
}): Promise<DeploymentView> {
  const id = deploymentId();
  const head = await deploymentStore.findRuleHead(input.serverId);
  const created = await deploymentStore.create({
    id,
    serverId: input.serverId,
    state: "queued",
    queuePosition: null,
    candidatePod: null,
    snapshotId: null,
    fromVersion: head?.currentVersion ?? null,
    toVersion: input.ruleSetVersion,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
    userId: input.userId,
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
    approvedContentDigest: input.approvedContentDigest,
    artifactUrl: null,
    artifactDigest: null,
    artifactRuntimeVersion: null,
    initiatedBy: input.initiatedBy,
    queueStatus: "waiting",
    workerId: null,
    leaseExpiresAt: null,
  });
  await startNext();
  const current = (await deploymentStore.find(id)) ?? created;
  return view(current);
}

export async function abortDeployment(
  id: string,
  error?: string,
  options: { admitWaiting?: boolean } = {},
): Promise<DeploymentView> {
  const requested = await deploymentStore.requestAbort(id, new Date());
  if (!requested) throw new Error("Deployment not found");
  if (
    PRE_CUTOVER_STATES.includes(requested.state as (typeof PRE_CUTOVER_STATES)[number]) &&
    requested.queueStatus === "running" &&
    requested.workerId
  ) {
    // The active worker owns any in-flight external operation. It observes the
    // durable request at its next checkpoint and compensates after that
    // operation settles, avoiding delete/recreate races with candidate B.
    return view(requested);
  }
  const result = await requestAndCompensate(id, error ?? "aborted by operator");
  if (result.state === "aborted" && options.admitWaiting !== false) await startNext();
  return view(result);
}

export async function abortDeploymentWithRuntime(
  id: string,
  runtime: DeploymentMachineRuntime,
  store: DeploymentStore,
  error = "aborted by operator",
): Promise<DeploymentRecord> {
  return requestAndCompensate(id, error, runtime, store);
}

export async function completeCutover(id: string): Promise<void> {
  const row = await deploymentStore.find(id);
  if (!row) throw new Error("Deployment not found");
  if (row.state !== "cutover" && row.state !== "draining" && row.state !== "idle") {
    throw new Error("Cutover is automatic and has not reached the post-cutover boundary");
  }
  if (row.state !== "idle") {
    await runPostCutover(id, productionRuntime, deploymentStore, deploymentQueue.workerId);
  }
}

export async function rollbackServer(input: {
  serverId: string;
  targetVersion: string;
  approvedContentDigest: string;
  initiatedBy: string;
  userId: string;
}): Promise<DeploymentView> {
  const targetError = await rollbackTargetError(
    input.serverId,
    input.targetVersion,
    input.approvedContentDigest,
  );
  if (targetError) throw new Error(targetError);
  return enqueueDeploy({
    serverId: input.serverId,
    ruleSetVersion: input.targetVersion,
    approvedContentDigest: input.approvedContentDigest,
    initiatedBy: input.initiatedBy,
    userId: input.userId,
  });
}

export function restartDisposition(
  row: Pick<DeploymentRecord, "state" | "queueStatus">,
): "resume_queue" | "abort_pre_cutover" | "preserve_post_cutover" {
  if (row.queueStatus === "waiting" && row.state === "queued") return "resume_queue";
  if (PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
    return "abort_pre_cutover";
  }
  return "preserve_post_cutover";
}

let scheduledReconcile: ReturnType<typeof setTimeout> | null = null;
let scheduledReconcileAt = 0;

function scheduleReconcileAt(timestamp: number): void {
  if (scheduledReconcile && scheduledReconcileAt <= timestamp) return;
  if (scheduledReconcile) clearTimeout(scheduledReconcile);
  scheduledReconcileAt = timestamp;
  scheduledReconcile = setTimeout(
    () => {
      scheduledReconcile = null;
      scheduledReconcileAt = 0;
      void reconcileInFlight();
    },
    Math.max(1, timestamp - Date.now()),
  );
  scheduledReconcile.unref?.();
}

export async function reconcileInFlight(): Promise<void> {
  if (scheduledReconcile) {
    clearTimeout(scheduledReconcile);
    scheduledReconcile = null;
    scheduledReconcileAt = 0;
  }
  await reconcilePendingCandidateCleanup();
  const recoverable = await deploymentStore.listRecoverable();
  let nextLeaseExpiry: number | null = null;

  for (const row of recoverable) {
    if (row.queueStatus === "waiting" && row.state === "queued") continue;
    if (activeMachines.has(row.id)) continue;

    const leaseExpiresAt = row.leaseExpiresAt ? new Date(row.leaseExpiresAt).getTime() : 0;
    let owned = row.workerId === deploymentQueue.workerId && leaseExpiresAt > Date.now();
    if (!owned) owned = await deploymentQueue.takeoverExpired(row.id);
    if (!owned) {
      const expiry = row.leaseExpiresAt ? new Date(row.leaseExpiresAt).getTime() : Date.now();
      nextLeaseExpiry = Math.min(nextLeaseExpiry ?? expiry, expiry);
      continue;
    }

    const disposition = restartDisposition(row);
    if (disposition === "abort_pre_cutover") {
      if (activeMachines.has(row.id)) continue;
      activeMachines.add(row.id);
      void requestAndCompensate(row.id, "reconciled after backend restart before cutover")
        .then(() => {
          activeMachines.delete(row.id);
          return startNext();
        })
        .catch((error) => {
          activeMachines.delete(row.id);
          console.error("[deploy " + row.id + "] restart compensation failed", error);
          scheduleReconcileAt(Date.now() + 15_000);
        });
    } else if (disposition === "preserve_post_cutover") {
      startMachine(row.id);
    }
  }

  await startNext();

  if (nextLeaseExpiry !== null) {
    scheduleReconcileAt(nextLeaseExpiry + 50);
  }
}

export function startDeploymentLeaseReaper(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void reconcileInFlight().catch((error) => {
      console.error("Deployment lease reconciliation failed", error);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
