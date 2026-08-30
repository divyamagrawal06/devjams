import { randomUUID } from "node:crypto";
import type { DeploymentState, DeploymentView } from "@farlands/contracts";
import { digestsEqual, PRE_CUTOVER_STATES } from "@farlands/contracts";
import { deleteCandidate, provisionCandidate } from "../provisioning/candidate";
import { releaseDeploymentHeadroom, reserveDeploymentHeadroom } from "../quota/headroom";
import { RulesService } from "../rules/service";
import { issueTransfer, waitForAck } from "../velocity/transfers";
import { AuthClient } from "./invariant";
import { type DurableDeploymentQueue, deploymentQueue } from "./queue";
import {
  type DeploymentPatch,
  type DeploymentRecord,
  type DeploymentStore,
  deploymentStore,
  type RuleHead,
} from "./store";

const nowIso = () => new Date().toISOString();

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
  return `dep_${randomUUID().replaceAll("-", "")}`;
}

function view(row: DeploymentRecord): DeploymentView {
  const {
    userId: _u,
    namespace: _n,
    liveDeployment: _d,
    liveService: _s,
    approvedContentDigest: _c,
    artifactUrl: _au,
    artifactDigest: _ad,
    artifactRuntimeVersion: _ar,
    initiatedBy: _i,
    queueStatus: _q,
    queueSequence: _qs,
    workerId: _w,
    leaseExpiresAt: _l,
    ...rest
  } = row;
  return rest;
}

function assertPreCutover(row: DeploymentRecord): void {
  if (!PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
    throw new Error(`Cannot abort after cutover (state=${row.state})`);
  }
}

async function transition(
  id: string,
  state: DeploymentState,
  patch: DeploymentPatch = {},
  detail: string | null = null,
): Promise<DeploymentRecord> {
  const current = await deploymentStore.find(id);
  if (current?.queueStatus === "running") {
    const renewed = await deploymentQueue.renew(id);
    if (!renewed) throw new Error(`Deployment ${id} lost its durable queue lease`);
  }
  const row = await deploymentStore.transition(id, state, patch, detail);
  row.queuePosition = state === "queued" ? await deploymentQueue.position(id) : null;
  return row;
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
    approvedContentDigest: input.approvedContentDigest,
    artifactUrl: null,
    artifactDigest: null,
    artifactRuntimeVersion: null,
    initiatedBy: input.initiatedBy,
    queueStatus: "waiting",
    workerId: null,
    leaseExpiresAt: null,
  });
  await startAvailable();
  const current = (await deploymentStore.find(id)) ?? created;
  return view(current);
}

function startMachine(id: string): void {
  const heartbeat = setInterval(() => {
    void deploymentQueue
      .renew(id)
      .then((renewed) => {
        if (!renewed) clearInterval(heartbeat);
      })
      .catch((error) => {
        clearInterval(heartbeat);
        console.error(`[deploy ${id}] lease heartbeat failed`, error);
      });
  }, deploymentQueue.heartbeatIntervalMs);
  heartbeat.unref?.();

  void runMachine(id)
    .catch(async (error) => {
      console.error(`[deploy ${id}] machine failed`, error);
      await failAndAbort(id, error);
    })
    .finally(() => clearInterval(heartbeat));
}

async function runMachine(id: string): Promise<void> {
  const row = await deploymentStore.find(id);
  if (row?.queueStatus !== "running") return;

  await transition(id, "building");
  const artifact = await RulesService.resolveDeploymentArtifact({
    serverId: row.serverId,
    userId: row.userId,
    ruleSetVersion: row.toVersion ?? "",
  });
  assertApprovedArtifactDigest(row.approvedContentDigest, artifact.artifactDigest);
  await RulesService.verifyDeploymentArtifact(artifact);
  await transition(
    id,
    "building",
    {
      artifactUrl: artifact.artifactUrl,
      artifactDigest: artifact.artifactDigest,
      artifactRuntimeVersion: artifact.runtimeMinecraftVersion,
    },
    `verified immutable artifact ${artifact.artifactDigest}`,
  );

  await transition(id, "staging");
  let candidate: Awaited<ReturnType<typeof provisionCandidate>>;
  try {
    await reserveDeploymentHeadroom(row.userId, row.serverId, id);
    candidate = await provisionCandidate({
      liveServerId: row.serverId,
      deploymentId: id,
      artifactUrl: artifact.artifactUrl,
      artifactDigest: artifact.artifactDigest,
      artifactRuntimeVersion: artifact.runtimeMinecraftVersion,
    });
    const leaseRetained = await fenceProvisionedCandidate({
      renew: () => deploymentQueue.renew(id),
      cleanup: () =>
        deleteCandidate({
          namespace: candidate.namespace,
          deploymentName: candidate.deploymentName,
          liveServerId: row.serverId,
          deploymentId: id,
        }),
      recordCleanupRetry: async (error) => {
        const current = await deploymentStore.find(id);
        const state = current?.state === "failed" ? "failed" : "aborted";
        await deploymentStore.transition(
          id,
          state,
          {
            candidatePod: candidate.deploymentName,
            namespace: candidate.namespace,
            error: `candidate cleanup pending: ${errorMessage(error)}`,
            finishedAt: nowIso(),
            queueStatus: "complete",
            workerId: null,
            leaseExpiresAt: null,
          },
          "candidate cleanup persisted for retry after lease loss",
        );
      },
      releaseHeadroom: () => releaseDeploymentHeadroom(id),
    });
    if (!leaseRetained) return;
    await transition(id, "staging", {
      candidatePod: candidate.deploymentName,
      namespace: candidate.namespace,
      liveDeployment: candidate.liveDeploymentName,
      liveService: candidate.liveServiceName,
    });
  } catch (error) {
    await failAndAbort(id, error);
    return;
  }

  const auth = new AuthClient("pre-cutover");
  auth.assertCannotTouchA();

  await transition(id, "presync");
  await transition(id, "freezing");
  await transition(id, "verifying");
}

async function failAndAbort(id: string, error: unknown): Promise<void> {
  const message = errorMessage(error);
  const row = await deploymentStore.find(id);
  if (!row) return;
  await abortDeployment(id, message);
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
          namespace: null,
          error: "candidate resources cleaned after lease loss",
        },
        "completed durable candidate cleanup retry",
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
      await abortDeployment(id, reason, { admitWaiting: false });
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
      );
      await actions.releaseHeadroom(row.id);
      reclaimed.push(row.id);
    }
  }
  return reclaimed;
}

async function startAvailable(): Promise<void> {
  await reconcileExpiredDeployments();
  await reconcilePendingCandidateCleanup();
  const admitted = await deploymentQueue.claimAvailable();
  for (const deploymentId of admitted) startMachine(deploymentId);
}

export function startDeploymentLeaseReaper(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void startAvailable().catch((error) => {
      console.error("Deployment lease reconciliation failed", error);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function abortDeployment(
  id: string,
  error?: string,
  options: { admitWaiting?: boolean } = {},
): Promise<DeploymentView> {
  const row = await deploymentStore.find(id);
  if (!row) throw new Error("Deployment not found");
  if (row.state === "aborted" || row.state === "failed") {
    await reconcilePendingCandidateCleanup();
    return view((await deploymentStore.find(id)) ?? row);
  }
  if (row.state === "idle") {
    return view(row);
  }
  if (row.state === "draining" || row.state === "cutover") {
    return view(row);
  }
  assertPreCutover(row);
  // Terminalize before external cleanup. Candidate identity is deliberately
  // preserved: an expired worker may publish it concurrently after returning
  // from a blocked provisioning call, and cleanup is retried from durable state.
  const next = await deploymentStore.transition(
    id,
    "aborted",
    {
      error: error ?? "aborted",
      finishedAt: nowIso(),
      queueStatus: "complete",
      workerId: null,
      leaseExpiresAt: null,
    },
    error ?? "aborted by operator",
  );
  await releaseDeploymentHeadroom(id);
  await reconcilePendingCandidateCleanup();
  if (options.admitWaiting !== false) await startAvailable();
  return view((await deploymentStore.find(id)) ?? next);
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

/**
 * On startup, queued work is re-admitted in durable FIFO order. Any deployment
 * that had begun but had not crossed cutover is conservatively aborted: the
 * approval remains spent, A remains authoritative, candidate resources are
 * cleaned up, and the audit trail records why. Post-cutover rows are left
 * untouched because only the cutover reconciler can safely decide their route.
 */
export async function reconcileInFlight(): Promise<void> {
  const recoverable = await deploymentStore.listRecoverable();
  for (const row of recoverable) {
    const disposition = restartDisposition(row);
    if (disposition === "resume_queue") continue;
    if (disposition === "abort_pre_cutover") {
      await abortDeployment(row.id, "reconciled after backend restart before cutover", {
        admitWaiting: false,
      });
      continue;
    }
    if (row.state === "draining") {
      await deploymentStore.transition(
        row.id,
        "idle",
        {
          finishedAt: nowIso(),
          queueStatus: "complete",
          workerId: null,
          leaseExpiresAt: null,
        },
        "finished committed cutover during startup reconciliation",
      );
      await releaseDeploymentHeadroom(row.id);
    }
  }
  await startAvailable();
}

export async function completeCutover(id: string): Promise<void> {
  const row = await deploymentStore.find(id);
  if (!row) throw new Error("Deployment not found");
  if (row.state !== "verifying") {
    throw new Error(`cutover only from verifying, got ${row.state}`);
  }
  if (!row.liveService || !row.candidatePod || !row.toVersion) {
    throw new Error("missing route metadata for cutover");
  }
  const transferId = await issueTransfer({
    deploymentId: id,
    fromRoute: "lobby",
    toRoute: row.candidatePod,
    message: "Moving you into the new world…",
    sourcePlayers: [],
  });
  await waitForAck(transferId);
  const draining = new AuthClient("draining");
  draining.assertCanRetireA();
  await deploymentStore.commitCutover({
    serverId: row.serverId,
    deploymentId: id,
    version: row.toVersion,
    digest: row.approvedContentDigest,
    workerId: deploymentQueue.workerId,
  });
  await transition(id, "idle", {
    finishedAt: nowIso(),
    queueStatus: "complete",
    workerId: null,
    leaseExpiresAt: null,
  });
  await releaseDeploymentHeadroom(id);
  await startAvailable();
}
