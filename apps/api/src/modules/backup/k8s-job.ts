import type * as k8s from "@kubernetes/client-node";
import { makeKubernetesClients } from "../../lib/k8s";
import { assertNoPendingServerCutover } from "../deploy/guard";
import { waitForDeploymentRolloutReady } from "../provisioning/kubernetes";
import { ensureBackupWorkerIdentity } from "../provisioning/tenancy";
import { runtimeLegacyBackupAttemptAdoptedAt } from "./attempt";
import {
  type BackupStorageConfig,
  parseBackupStorageKey,
  resolveBackupStorageConfig,
} from "./config";
import {
  acquireBackupLease,
  assertBackupLeaseFence,
  assertBackupLeaseRemaining,
  assertBackupLeaseRenewalFence,
  BackupLeaseAcquisitionUncertainError,
  backupLeaseHolder,
  legacyBackupOperationAttempt,
  releaseBackupLeaseWithRetry,
} from "./lock";

// ── env vars ──────────────────────────────────────────────────────────────────
// Runtime/image settings have safe defaults matching the cronjob Terraform.
// Bucket, region, and prefix resolution is centralized in config.ts.

export function resolveImmutableBackupImage(
  name: string,
  configured: string | undefined,
  fallback: string,
): string {
  const image = configured?.trim() || fallback;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${name} must be pinned by sha256 digest`);
  }
  return image;
}

const ARCHIVE_IMAGE = resolveImmutableBackupImage(
  "BACKUP_IMAGE_ARCHIVE",
  process.env.BACKUP_IMAGE_ARCHIVE,
  "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
);
const UPLOAD_IMAGE = resolveImmutableBackupImage(
  "BACKUP_IMAGE_UPLOAD",
  process.env.BACKUP_IMAGE_UPLOAD,
  "amazon/aws-cli:2.15.0@sha256:e2a778146a45cb7cdcc55e3051c0de38ea9f180ed88383447f7ead6b0ba5e9a4",
);
const SERVICE_ACCOUNT =
  process.env.FARLANDS_BACKUP_WORKER_SERVICE_ACCOUNT ??
  process.env.BACKUP_SERVICE_ACCOUNT ??
  "backup-orchestrator";
const TEMP_SIZE_LIMIT = process.env.BACKUP_TEMP_SIZE_LIMIT ?? "25Gi";
const BACKUP_NAMESPACE = process.env.BACKUP_NAMESPACE ?? "infra-team";
const WEEKLY_CRONJOB_NAME = process.env.BACKUP_CRONJOB_NAME ?? "server-backup-orchestrator";
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const JOB_ACTIVE_DEADLINE_SECONDS = 2 * 60 * 60;
const JOB_LEASE_HEADROOM_SECONDS = 30 * 60;
const JOB_LEASE_TERMINATION_MARGIN_SECONDS = 5 * 60;
const JOB_LEASE_DURATION_SECONDS = JOB_ACTIVE_DEADLINE_SECONDS + JOB_LEASE_HEADROOM_SECONDS;
const JOB_REQUIRED_LEASE_REMAINING_MS =
  (JOB_ACTIVE_DEADLINE_SECONDS + JOB_LEASE_TERMINATION_MARGIN_SECONDS) * 1_000;
export const BACKUP_ATTEMPT_LABEL = "farlands.dev/backup-attempt-id";
export const BACKUP_ATTEMPT_ANNOTATION = "farlands.dev/backup-operation-attempt-id";
const LEGACY_JOB_CREATION_CLOCK_SKEW_MS = 5_000;
const RESTRICTED_CONTAINER_SECURITY_CONTEXT: k8s.V1SecurityContext = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  capabilities: { drop: ["ALL"] },
};
const BACKUP_RESOURCES: k8s.V1ResourceRequirements = {
  requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "1Gi" },
  limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": TEMP_SIZE_LIMIT },
};

export class BackupJobNotStartedError extends Error {
  readonly operation: "create" | "restore" | "delete";

  constructor(operation: "create" | "restore" | "delete", cause: unknown) {
    super(`Backup ${operation} Job was not started`, { cause });
    this.name = "BackupJobNotStartedError";
    this.operation = operation;
  }
}

async function renewJobLeaseWithRequiredValidity(
  namespace: string,
  serverId: string,
  holder: string,
  previousConfirmedUntil: number,
): Promise<Date> {
  const requestStartedAt = Date.now();
  assertBackupLeaseFence(previousConfirmedUntil, requestStartedAt);
  const deadline = await acquireBackupLease(
    namespace,
    serverId,
    holder,
    JOB_LEASE_DURATION_SECONDS,
  );
  const confirmedAt = Date.now();
  assertBackupLeaseRenewalFence(
    previousConfirmedUntil,
    deadline.getTime(),
    requestStartedAt,
    confirmedAt,
  );
  if (deadline.getTime() - confirmedAt < JOB_REQUIRED_LEASE_REMAINING_MS) {
    throw new BackupLeaseAcquisitionUncertainError(serverId, {
      cause: new Error("Confirmed backup Lease does not cover the worker Job deadline"),
    });
  }
  return deadline;
}

const ARCHIVE_PATH_CHECK =
  "tar -tzf /backup/restore.tar.gz | awk 'BEGIN { bad=0 } /^\\// { bad=1 } /(^|\\/)\\.\\.(\\/|$)/ { bad=1 } /^\\.\\/\\.farlands-restore-(staging|rollback)(\\/|$)/ { bad=1 } END { exit bad }'";
const RESTORE_SCRIPT = [
  "set -eu",
  "ROOT=/world",
  'STAGE="$ROOT/.farlands-restore-staging"',
  'ROLLBACK="$ROOT/.farlands-restore-rollback"',
  "SWITCH_STARTED=0",
  "NEW_STARTED=0",
  'move_children() { for item in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$item" ] || continue; mv -- "$item" "$2/" || return 1; done; }',
  'move_root_to_rollback() { for item in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do [ -e "$item" ] || continue; case "$item" in "$STAGE"|"$ROLLBACK") continue ;; esac; mv -- "$item" "$ROLLBACK/" || return 1; done; }',
  'clear_new_root() { for item in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do [ -e "$item" ] || continue; case "$item" in "$STAGE"|"$ROLLBACK") continue ;; esac; rm -rf -- "$item" || return 1; done; }',
  'rollback() { code=$?; if [ "$code" -ne 0 ]; then rm -rf -- "$STAGE"; if [ "$SWITCH_STARTED" -eq 1 ]; then if [ "$NEW_STARTED" -eq 1 ] && ! clear_new_root; then echo "Automatic rollback could not clear the failed restore; recovery data remains at $ROLLBACK" >&2; exit "$code"; fi; if ! move_children "$ROLLBACK" "$ROOT"; then echo "Automatic rollback was incomplete; recovery data remains at $ROLLBACK" >&2; exit "$code"; fi; rmdir "$ROLLBACK" 2>/dev/null || true; fi; fi; exit "$code"; }',
  "trap rollback EXIT",
  'rm -rf -- "$STAGE"',
  'if [ -d "$ROLLBACK" ] && [ -n "$(find "$ROLLBACK" -mindepth 1 -print -quit)" ]; then echo "Restore blocked: manual recovery data exists at $ROLLBACK" >&2; exit 1; fi',
  'rm -rf -- "$ROLLBACK"',
  'mkdir -p "$STAGE" "$ROLLBACK"',
  ARCHIVE_PATH_CHECK,
  'tar -xzf /backup/restore.tar.gz -C "$STAGE"',
  'test -f "$STAGE/server.properties" || test -f "$STAGE/world/level.dat" || test -f "$STAGE/level.dat"',
  "SWITCH_STARTED=1",
  "move_root_to_rollback",
  "NEW_STARTED=1",
  'move_children "$STAGE" "$ROOT"',
  'test -f "$ROOT/server.properties" || test -f "$ROOT/world/level.dat" || test -f "$ROOT/level.dat"',
  "SWITCH_STARTED=0",
  'rm -rf -- "$STAGE" "$ROLLBACK"',
  "trap - EXIT",
].join("\n");

export type BackupJobState =
  | { status: "pending" }
  | { status: "missing" }
  | { status: "completed"; jobName: string; operation: string; storagePath?: string }
  | { status: "failed"; jobName: string; operation: string };

export type BackupCronJobState = {
  exists: boolean;
  lastScheduleAt: Date | null;
  lastSuccessfulAt: Date | null;
  schedule: string | null;
  suspended: boolean;
  timeZone: string | null;
};

function kubernetesStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
    body?: { code?: unknown };
  };
  const raw =
    candidate.statusCode ??
    candidate.code ??
    candidate.response?.statusCode ??
    candidate.body?.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d{3}$/.test(raw)) return Number(raw);
  return undefined;
}

export function kubernetesCreateErrorIsAmbiguous(error: unknown): boolean {
  const code = kubernetesStatusCode(error);
  return code === undefined || code === 408 || code === 429 || code >= 500;
}

export function backupJobMatchesOperationAttempt(
  job: k8s.V1Job,
  serverId: string,
  backupId: string,
  operation: "create" | "restore" | "delete",
  attemptId: string,
  operationStartedAt: Date | null,
): boolean {
  const labels = job.metadata?.labels;
  const annotations = job.metadata?.annotations;
  const jobCreatedAt = job.metadata?.creationTimestamp;
  const runtimeAdoptedLegacyAttempt = runtimeLegacyBackupAttemptAdoptedAt(attemptId) !== null;
  const attemptMatches = legacyBackupOperationAttempt(attemptId)
    ? labels?.[BACKUP_ATTEMPT_LABEL] === undefined &&
      annotations?.[BACKUP_ATTEMPT_ANNOTATION] === undefined &&
      // Migration 0014 had no durable delete-start timestamp and stamped
      // active deletes at rollout time, after their legitimate Job creation.
      // Old delete Jobs were timestamp-named; selecting the newest unlabeled
      // match below is the only recoverable generation for that legacy case.
      ((operation === "delete" && !runtimeAdoptedLegacyAttempt) ||
        (operationStartedAt !== null &&
          jobCreatedAt !== undefined &&
          jobCreatedAt.getTime() >=
            operationStartedAt.getTime() - LEGACY_JOB_CREATION_CLOCK_SKEW_MS))
    : labels?.[BACKUP_ATTEMPT_LABEL] === attemptId &&
      annotations?.[BACKUP_ATTEMPT_ANNOTATION] === attemptId;
  return (
    labels?.["farlands.dev/server-id"] === serverId &&
    labels?.["farlands.dev/backup-id"] === backupId &&
    labels?.["farlands.dev/backup-operation"] === operation &&
    attemptMatches
  );
}

export function selectBackupJobForAttempt(
  jobs: k8s.V1Job[],
  serverId: string,
  backupId: string,
  operation: "create" | "restore" | "delete",
  attemptId: string,
  operationStartedAt: Date | null,
): k8s.V1Job | undefined {
  return jobs
    .filter(
      (job) =>
        job.metadata?.name &&
        backupJobMatchesOperationAttempt(
          job,
          serverId,
          backupId,
          operation,
          attemptId,
          operationStartedAt,
        ),
    )
    .sort(
      (left, right) =>
        (right.metadata?.creationTimestamp?.getTime() ?? 0) -
        (left.metadata?.creationTimestamp?.getTime() ?? 0),
    )[0];
}

export function backupJobLookupNamespaces(namespace: string, attemptId: string): string[] {
  return legacyBackupOperationAttempt(attemptId)
    ? [...new Set([namespace, BACKUP_NAMESPACE])]
    : [namespace];
}

export function legacyCreateJobStoragePath(
  job: k8s.V1Job,
  serverId: string,
  attemptId: string,
  configuredPrefix: string,
): string | null {
  if (!legacyBackupOperationAttempt(attemptId)) return null;

  const uploadContainers = (job.spec?.template.spec?.containers ?? []).filter(
    (container) => container.name === "upload-backup",
  );
  if (uploadContainers.length !== 1) return null;

  const storageEntries = (uploadContainers[0]?.env ?? []).filter(
    (entry) => entry.name === "STORAGE_PATH" && typeof entry.value === "string",
  );
  if (storageEntries.length !== 1) return null;

  const storagePath = storageEntries[0]?.value ?? "";
  if (!storagePath || storagePath !== storagePath.trim() || storagePath.length > 1_024) return null;
  const parsed = parseBackupStorageKey(storagePath, configuredPrefix);
  if (!parsed || parsed.serverId !== serverId || parsed.source !== "manual") return null;

  const timestamp = parsed.filename.slice(serverId.length + 1, -".tar.gz".length);
  if (
    !parsed.filename.startsWith(`${serverId}-`) ||
    !parsed.filename.endsWith(".tar.gz") ||
    !/^\d{8}T\d{6}Z$/.test(timestamp)
  ) {
    return null;
  }
  return storagePath;
}

export async function getBackupCronJobState(): Promise<BackupCronJobState> {
  try {
    const { batch } = makeKubernetesClients();
    const cronJob = await batch.readNamespacedCronJob({
      name: WEEKLY_CRONJOB_NAME,
      namespace: BACKUP_NAMESPACE,
    });
    return {
      exists: true,
      lastScheduleAt: cronJob.status?.lastScheduleTime ?? null,
      lastSuccessfulAt: cronJob.status?.lastSuccessfulTime ?? null,
      schedule: cronJob.spec?.schedule ?? null,
      suspended: cronJob.spec?.suspend === true,
      timeZone: cronJob.spec?.timeZone ?? null,
    };
  } catch (error) {
    console.warn(
      `[backup] Weekly CronJob '${BACKUP_NAMESPACE}/${WEEKLY_CRONJOB_NAME}' is unavailable:`,
      error instanceof Error ? error.message : "unknown Kubernetes error",
    );
    return {
      exists: false,
      lastScheduleAt: null,
      lastSuccessfulAt: null,
      schedule: null,
      suspended: false,
      timeZone: null,
    };
  }
}

async function createLockedJob(
  jobSpec: k8s.V1Job | ((assertLeaseHeld: () => void) => Promise<k8s.V1Job>),
  namespace: string,
  serverId: string,
  backupId: string,
  operation: "create" | "restore" | "delete",
  attemptId: string,
  operationAttemptIsActive: () => Promise<boolean>,
): Promise<void> {
  const { batch, core } = makeKubernetesClients();
  // Create or validate the same IRSA identity used by the weekly scheduler.
  // This runs before the Lease claim, so an infrastructure drift cannot leave
  // a manual operation stuck behind a Job that never had S3 credentials.
  await ensureBackupWorkerIdentity(core, namespace);

  const holder = backupLeaseHolder(operation, backupId, attemptId);
  let confirmedUntil: number;
  try {
    const initialDeadline = await acquireBackupLease(
      namespace,
      serverId,
      holder,
      JOB_LEASE_DURATION_SECONDS,
    );
    confirmedUntil = initialDeadline.getTime();
    assertBackupLeaseFence(confirmedUntil);
  } catch (error) {
    if (error instanceof BackupLeaseAcquisitionUncertainError) {
      // The API may have persisted this deterministic holder. Return as an
      // ambiguous dispatch so the durable DB claim and monitor remain intact.
      console.error(`[backup] ${error.message}; retaining the operation claim for reconciliation`);
      return;
    }
    throw error;
  }

  const durableAttemptIsActive = async (): Promise<boolean> => {
    let active: boolean;
    try {
      active = await operationAttemptIsActive();
    } catch (error) {
      // Database uncertainty must never authorize a PVC/S3 mutation. Retain
      // the Lease so reconciliation can safely resolve the durable claim.
      console.error(
        `[backup] Could not confirm durable attempt '${attemptId}' before Job dispatch; retaining its Lease:`,
        error,
      );
      return false;
    }
    if (active) return true;

    try {
      await releaseBackupLeaseWithRetry(namespace, serverId, holder);
    } catch (releaseError) {
      console.error(
        `[backup] Could not release superseded attempt Lease '${holder}'; no Job will be created:`,
        releaseError,
      );
    }
    return false;
  };

  // A dispatcher may resume after its original Lease expired and missing-Job
  // reconciliation finalized the database attempt. Check immediately after
  // acquisition, before restore preparation can quiesce a promoted workload.
  if (!(await durableAttemptIsActive())) return;

  let resolvedJobSpec: k8s.V1Job;
  try {
    // The Kubernetes Lease serializes live operations, while this database
    // checkpoint survives a crashed cutover controller after its Lease expires.
    await assertNoPendingServerCutover(serverId);
    assertBackupLeaseFence(confirmedUntil);
    resolvedJobSpec =
      typeof jobSpec === "function"
        ? await jobSpec(() => assertBackupLeaseFence(confirmedUntil))
        : jobSpec;
  } catch (prepareError) {
    try {
      await releaseBackupLeaseWithRetry(namespace, serverId, holder);
    } catch (releaseError) {
      console.error(
        `[backup] Could not release the Lease after Job preparation failed for '${holder}'; retaining its claim for reconciliation:`,
        releaseError,
      );
      return;
    }
    throw new BackupJobNotStartedError(operation, prepareError);
  }
  const jobName = resolvedJobSpec.metadata?.name;
  if (!jobName) {
    try {
      await releaseBackupLeaseWithRetry(namespace, serverId, holder);
    } catch (releaseError) {
      // Keep the durable database claim when the Lease cannot be confirmed
      // released. Missing-Job reconciliation will retry the cleanup.
      console.error(`[backup] Failed to release invalid Job lease '${holder}':`, releaseError);
      return;
    }
    throw new BackupJobNotStartedError(operation, new Error("Backup Job is missing metadata.name"));
  }
  try {
    // Restore preparation can spend minutes quiescing Pods. Re-stamp the Lease
    // immediately before Job creation and prove that it outlives the worker's
    // own deadline plus termination margin.
    confirmedUntil = (
      await renewJobLeaseWithRequiredValidity(namespace, serverId, holder, confirmedUntil)
    ).getTime();
  } catch (renewError) {
    console.error(
      `[backup] Could not confirm enough Lease validity to create Job '${jobName}'; retaining the durable claim for reconciliation:`,
      renewError,
    );
    return;
  }
  // The final renewal excludes missing-Job reconciliation while this second
  // durable check and Job creation run. A cleared/superseded attempt must not
  // be able to create a late worker after reacquiring a free Lease.
  if (!(await durableAttemptIsActive())) return;
  try {
    assertBackupLeaseRemaining(confirmedUntil, JOB_REQUIRED_LEASE_REMAINING_MS);
  } catch (fenceError) {
    console.error(
      `[backup] Refusing to create Job '${jobName}' without enough remaining Lease validity:`,
      fenceError,
    );
    return;
  }
  try {
    await batch.createNamespacedJob({ namespace, body: resolvedJobSpec });
    await renewJobLeaseWithRequiredValidity(namespace, serverId, holder, confirmedUntil).catch(
      (renewError) => {
        console.error(
          `[backup] Could not extend Lease after creating Job '${jobName}':`,
          renewError,
        );
      },
    );
  } catch (createError) {
    try {
      const existing = await batch.readNamespacedJob({ name: jobName, namespace });
      if (
        backupJobMatchesOperationAttempt(existing, serverId, backupId, operation, attemptId, null)
      ) {
        await renewJobLeaseWithRequiredValidity(namespace, serverId, holder, confirmedUntil).catch(
          (renewError) => {
            console.error(
              `[backup] Could not extend Lease after confirming Job '${jobName}':`,
              renewError,
            );
          },
        );
        console.warn(
          `[backup] Job creation for '${jobName}' returned an error, but read-back confirmed it was accepted.`,
        );
        return;
      }

      // A same-name Job with different labels is ambiguous and must keep the
      // Lease. The monitor will fail this claim after its dispatch grace period.
      console.error(`[backup] Job '${jobName}' exists with unexpected operation labels.`);
      return;
    } catch (readError) {
      if (kubernetesStatusCode(readError) !== 404) {
        // Do not release on an ambiguous network/API failure: Kubernetes may
        // have accepted a restore that is already mutating the PVC.
        console.error(
          `[backup] Could not confirm whether Job '${jobName}' was created; retaining its Lease for reconciliation.`,
          readError,
        );
        return;
      }

      if (kubernetesCreateErrorIsAmbiguous(createError)) {
        console.error(
          `[backup] Job '${jobName}' is not visible after an ambiguous create response; retaining its Lease for bounded reconciliation.`,
          createError,
        );
        return;
      }
    }

    try {
      await releaseBackupLeaseWithRetry(namespace, serverId, holder);
    } catch (releaseError) {
      // Treat release uncertainty like dispatch uncertainty. Returning keeps
      // the DB claim active so the monitor can reconcile the missing Job and
      // retry Lease cleanup instead of opening a conflicting operation.
      console.error(
        `[backup] Could not confirm release of failed operation lease '${holder}'; retaining its claim for reconciliation:`,
        releaseError,
      );
      return;
    }
    throw new BackupJobNotStartedError(operation, createError);
  }
}

export async function releaseBackupOperationLease(
  namespace: string,
  serverId: string,
  backupId: string,
  operation: "create" | "restore" | "delete",
  attemptId: string,
): Promise<void> {
  await releaseBackupLeaseWithRetry(
    namespace,
    serverId,
    backupLeaseHolder(operation, backupId, attemptId),
  );
}

export function serverPodsAreQuiesced(pods: k8s.V1Pod[]): boolean {
  return pods.every((pod) => pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed");
}

async function waitForServerPodsQuiesced(
  core: k8s.CoreV1Api,
  namespace: string,
  serverId: string,
  activeDeploymentSelector: string,
  { timeoutMs = 180_000, intervalMs = 2_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const backupSelector = `farlands.dev/backup-server-id=${serverId}`;

  while (Date.now() < deadline) {
    const podLists = await Promise.all(
      [...new Set([backupSelector, activeDeploymentSelector])].map((labelSelector) =>
        core.listNamespacedPod({ namespace, labelSelector }),
      ),
    );
    const pods = [
      ...new Map(
        podLists
          .flatMap((list) => list.items)
          .map((pod) => [pod.metadata?.uid ?? pod.metadata?.name, pod] as const),
      ).values(),
    ];
    if (serverPodsAreQuiesced(pods)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for server '${serverId}' pods to release its PVC`);
}

async function quiesceServerForRestore(
  namespace: string,
  serverId: string,
  deploymentName: string,
  assertLeaseHeld: () => void,
): Promise<void> {
  const { apps, core } = makeKubernetesClients();
  const current = await apps.readNamespacedDeployment({ name: deploymentName, namespace });
  const matchLabels = current.spec?.selector.matchLabels ?? {};
  const activeDeploymentSelector = Object.entries(matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  if (!activeDeploymentSelector) {
    throw new Error(`Active Deployment '${namespace}/${deploymentName}' has no pod label selector`);
  }
  let minimumGeneration = current.metadata?.generation ?? 0;

  if ((current.spec?.replicas ?? 1) !== 0) {
    // Keep this synchronous deadline check adjacent to the mutating request:
    // a process paused beyond its confirmed ownership window must not scale a
    // successor Deployment after another holder used the Lease.
    assertLeaseHeld();
    const patched = await apps.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: 0 }],
      fieldManager: "farlands-backup-restore",
    });
    minimumGeneration = patched.metadata?.generation ?? Math.max(minimumGeneration + 1, 1);
  }

  await waitForDeploymentRolloutReady(apps, deploymentName, namespace, 0, minimumGeneration);
  await waitForServerPodsQuiesced(core, namespace, serverId, activeDeploymentSelector);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sanitizeJobName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

export function backupOperationJobName(
  operation: "create" | "restore" | "delete",
  attemptId: string,
): string {
  if (attemptId.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(attemptId)) {
    throw new Error("Backup operation attempt ID must be a valid Kubernetes label value");
  }
  return sanitizeJobName(`${operation}-${attemptId}`);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Dispatches a Kubernetes Job that archives the server's PVC and uploads it to
 * S3. The job uses the same two-container pattern as the cronjob orchestrator:
 *   1. init-container (alpine + tar): creates the archive
 *   2. main container (aws-cli):      uploads it to S3
 *
 * Returns the K8s job name so it can be stored for later correlation.
 *
 * @param backupId    - The DB backup record ID (used as a label for tracing)
 * @param serverId    - The game server ID (used for labels and S3 key)
 * @param namespace   - The server's tenant namespace (PVCs are namespace-scoped)
 * @param pvcName     - The PVC to archive (looked up from serverK8s)
 * @param storagePath - The full S3 key (e.g. "infra-team/<serverId>/<file>.tar.gz")
 *                      Caller computes this so the DB record and the job agree.
 */
export async function dispatchBackupJob(
  backupId: string,
  serverId: string,
  namespace: string,
  attemptId: string,
  operationAttemptIsActive: () => Promise<boolean>,
  resolveServiceName: string | (() => Promise<string>),
  storagePath: string,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const archiveFile = storagePath.split("/").pop()!;
  const jobName = backupOperationJobName("create", attemptId);

  const buildJobSpec = async (): Promise<k8s.V1Job> => {
    const serviceName =
      typeof resolveServiceName === "function" ? await resolveServiceName() : resolveServiceName;
    return {
      metadata: {
        name: jobName,
        namespace,
        labels: {
          app: "server-backup-worker",
          "farlands.dev/server-id": serverId,
          "farlands.dev/backup-id": backupId,
          "farlands.dev/backup-operation": "create",
          [BACKUP_ATTEMPT_LABEL]: attemptId,
        },
        annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
      },
      spec: {
        // Retain terminal evidence long enough for API restarts and reconciliation.
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        activeDeadlineSeconds: JOB_ACTIVE_DEADLINE_SECONDS,
        backoffLimit: 2,
        template: {
          metadata: {
            labels: {
              app: "server-backup-worker",
              "farlands.dev/server-id": serverId,
              "farlands.dev/backup-id": backupId,
              "farlands.dev/backup-operation": "create",
              [BACKUP_ATTEMPT_LABEL]: attemptId,
            },
            annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
          },
          spec: {
            serviceAccountName: SERVICE_ACCOUNT,
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            terminationGracePeriodSeconds: 30,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },

            // The game-server nodes carry a NoSchedule taint. Without this
            // toleration the scheduler cannot place the backup pod there.
            tolerations: [
              {
                key: "farlands.sh/nodepool",
                operator: "Equal",
                value: "infra-team-autoscale",
                effect: "NoSchedule",
              },
            ],

            initContainers: [
              {
                name: "create-backup",
                image: ARCHIVE_IMAGE,
                command: [
                  "/bin/sh",
                  "-c",
                  'set -eu; wget --quiet --output-document "/backup/${ARCHIVE_FILE}" --post-data="" "${BACKUP_ENDPOINT}"; test -s "/backup/${ARCHIVE_FILE}"; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -q .; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -Eq "^\\./(server\\.properties|world/level\\.dat|level\\.dat)$"',
                ],
                env: [
                  { name: "ARCHIVE_FILE", value: archiveFile },
                  {
                    name: "BACKUP_ENDPOINT",
                    value: backupSidecarEndpoint(serviceName),
                  },
                ],
                resources: BACKUP_RESOURCES,
                securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
                volumeMounts: [{ name: "backup-temp", mountPath: "/backup" }],
              },
              {
                name: "validate-backup",
                image: ARCHIVE_IMAGE,
                command: [
                  "/bin/sh",
                  "-c",
                  'set -eu; tar -tzf "/backup/${ARCHIVE_FILE}" >/dev/null; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -Eq "^\\./(server\\.properties|world/level\\.dat|level\\.dat)$"',
                ],
                env: [{ name: "ARCHIVE_FILE", value: archiveFile }],
                resources: BACKUP_RESOURCES,
                securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
                volumeMounts: [{ name: "backup-temp", mountPath: "/backup", readOnly: true }],
              },
            ],
            containers: [
              {
                name: "upload-backup",
                image: UPLOAD_IMAGE,
                command: [
                  "/bin/sh",
                  "-c",
                  'set -eu; aws s3 cp "/backup/${ARCHIVE_FILE}" "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" --region "${AWS_REGION}" --sse AES256 --checksum-algorithm SHA256 --content-type application/gzip --no-progress --only-show-errors; REMOTE_CHECKSUM="$(aws s3api head-object --bucket "${BACKUP_BUCKET}" --key "${STORAGE_PATH}" --region "${AWS_REGION}" --checksum-mode ENABLED --query ChecksumSHA256 --output text)"; test -n "${REMOTE_CHECKSUM}"; test "${REMOTE_CHECKSUM}" != "None"',
                ],
                env: [
                  { name: "ARCHIVE_FILE", value: archiveFile },
                  { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                  { name: "STORAGE_PATH", value: storagePath },
                  { name: "AWS_REGION", value: storageConfig.region },
                  { name: "HOME", value: "/tmp" },
                ],
                resources: BACKUP_RESOURCES,
                securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
                volumeMounts: [
                  { name: "backup-temp", mountPath: "/backup", readOnly: true },
                  { name: "runtime-temp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "backup-temp", emptyDir: { sizeLimit: TEMP_SIZE_LIMIT } },
              { name: "runtime-temp", emptyDir: {} },
            ],
          },
        },
      },
    };
  };

  await createLockedJob(
    buildJobSpec,
    namespace,
    serverId,
    backupId,
    "create",
    attemptId,
    operationAttemptIsActive,
  );

  console.info(
    `[backup] Dispatched K8s job '${jobName}' for server '${serverId}' -> s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

export function backupSidecarEndpoint(serviceName: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceName) || serviceName.length > 63) {
    throw new Error("Backup Service name must be a valid Kubernetes DNS label");
  }
  return `http://${serviceName}:8080/backup`;
}

/**
 * Dispatches the S3 deletion step using the same in-cluster identity as
 * backup creation. The API's local credentials do not have bucket access, so
 * deleting from the backend process itself would leave the archive behind.
 */
export async function dispatchBackupDeleteJob(
  backupId: string,
  serverId: string,
  namespace: string,
  attemptId: string,
  operationAttemptIsActive: () => Promise<boolean>,
  storagePath: string,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const jobName = backupOperationJobName("delete", attemptId);
  const jobSpec = buildBackupDeleteJob(
    jobName,
    backupId,
    serverId,
    namespace,
    attemptId,
    storagePath,
    storageConfig,
  );

  await createLockedJob(
    jobSpec,
    namespace,
    serverId,
    backupId,
    "delete",
    attemptId,
    operationAttemptIsActive,
  );

  console.info(
    `[backup] Dispatched delete job '${jobName}' for backup '${backupId}' -> s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

export function buildBackupDeleteJob(
  jobName: string,
  backupId: string,
  serverId: string,
  namespace: string,
  attemptId: string,
  storagePath: string,
  storageConfig: BackupStorageConfig = resolveBackupStorageConfig(),
): k8s.V1Job {
  return {
    metadata: {
      name: jobName,
      namespace,
      labels: {
        app: "server-backup-delete-worker",
        "farlands.dev/server-id": serverId,
        "farlands.dev/backup-id": backupId,
        "farlands.dev/backup-operation": "delete",
        [BACKUP_ATTEMPT_LABEL]: attemptId,
      },
      annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
    },
    spec: {
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      activeDeadlineSeconds: JOB_ACTIVE_DEADLINE_SECONDS,
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            app: "server-backup-delete-worker",
            "farlands.dev/server-id": serverId,
            "farlands.dev/backup-id": backupId,
            "farlands.dev/backup-operation": "delete",
            [BACKUP_ATTEMPT_LABEL]: attemptId,
          },
          annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
        },
        spec: {
          serviceAccountName: SERVICE_ACCOUNT,
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "delete-backup",
              image: UPLOAD_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'aws s3 rm "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" --region "${AWS_REGION}"',
              ],
              env: [
                { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                { name: "STORAGE_PATH", value: storagePath },
                { name: "AWS_REGION", value: storageConfig.region },
                { name: "HOME", value: "/tmp" },
              ],
              resources: BACKUP_RESOURCES,
              securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
              volumeMounts: [{ name: "runtime-temp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "runtime-temp", emptyDir: {} }],
        },
      },
    },
  };
}

/**
 * Dispatches a Kubernetes Job that replaces a stopped server's PVC contents
 * with a completed archive from S3. The archive is downloaded into an
 * emptyDir before the restore container touches the PVC, so a download failure
 * cannot leave the server data partially erased.
 */
export async function dispatchBackupRestoreJob(
  backupId: string,
  serverId: string,
  namespace: string,
  attemptId: string,
  operationAttemptIsActive: () => Promise<boolean>,
  storagePath: string,
  resolveTarget: () => Promise<{ deploymentName: string; pvcName: string }>,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const jobName = backupOperationJobName("restore", attemptId);

  await createLockedJob(
    async (assertLeaseHeld) => {
      // Resolve the active PVC only after the per-server Lease is held. A
      // queued cutover may have promoted a candidate while restore waited.
      const target = await resolveTarget();
      await quiesceServerForRestore(namespace, serverId, target.deploymentName, assertLeaseHeld);
      return buildBackupRestoreJob(
        jobName,
        backupId,
        serverId,
        namespace,
        attemptId,
        target.pvcName,
        storagePath,
        storageConfig,
      );
    },
    namespace,
    serverId,
    backupId,
    "restore",
    attemptId,
    operationAttemptIsActive,
  );

  console.info(
    `[backup] Dispatched restore job '${jobName}' for backup '${backupId}' from s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

export function buildBackupRestoreJob(
  jobName: string,
  backupId: string,
  serverId: string,
  namespace: string,
  attemptId: string,
  pvcName: string,
  storagePath: string,
  storageConfig: BackupStorageConfig = resolveBackupStorageConfig(),
): k8s.V1Job {
  return {
    metadata: {
      name: jobName,
      namespace,
      labels: {
        app: "server-backup-restore-worker",
        "farlands.dev/server-id": serverId,
        "farlands.dev/backup-id": backupId,
        "farlands.dev/backup-operation": "restore",
        [BACKUP_ATTEMPT_LABEL]: attemptId,
      },
      annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
    },
    spec: {
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      activeDeadlineSeconds: JOB_ACTIVE_DEADLINE_SECONDS,
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            app: "server-backup-restore-worker",
            "farlands.dev/server-id": serverId,
            "farlands.dev/backup-id": backupId,
            "farlands.dev/backup-operation": "restore",
            [BACKUP_ATTEMPT_LABEL]: attemptId,
          },
          annotations: { [BACKUP_ATTEMPT_ANNOTATION]: attemptId },
        },
        spec: {
          serviceAccountName: SERVICE_ACCOUNT,
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          tolerations: [
            {
              key: "farlands.sh/nodepool",
              operator: "Equal",
              value: "infra-team-autoscale",
              effect: "NoSchedule",
            },
          ],
          initContainers: [
            {
              name: "download-backup",
              image: UPLOAD_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'aws s3 cp "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" /backup/restore.tar.gz --region "${AWS_REGION}" --checksum-mode ENABLED --no-progress --only-show-errors',
              ],
              env: [
                { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                { name: "STORAGE_PATH", value: storagePath },
                { name: "AWS_REGION", value: storageConfig.region },
                { name: "HOME", value: "/tmp" },
              ],
              resources: BACKUP_RESOURCES,
              securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
              volumeMounts: [
                { name: "backup-temp", mountPath: "/backup" },
                { name: "runtime-temp", mountPath: "/tmp" },
              ],
            },
            {
              name: "validate-backup",
              image: ARCHIVE_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                `set -eu; tar -tzf /backup/restore.tar.gz >/dev/null; tar -tzf /backup/restore.tar.gz | grep -q .; ${ARCHIVE_PATH_CHECK}`,
              ],
              resources: BACKUP_RESOURCES,
              securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
              volumeMounts: [{ name: "backup-temp", mountPath: "/backup", readOnly: true }],
            },
          ],
          containers: [
            {
              name: "restore-backup",
              image: ARCHIVE_IMAGE,
              command: ["/bin/sh", "-c", RESTORE_SCRIPT],
              resources: BACKUP_RESOURCES,
              securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
              volumeMounts: [
                { name: "server-data", mountPath: "/world" },
                { name: "backup-temp", mountPath: "/backup", readOnly: true },
              ],
            },
          ],
          volumes: [
            {
              name: "server-data",
              persistentVolumeClaim: { claimName: pvcName },
            },
            { name: "backup-temp", emptyDir: { sizeLimit: TEMP_SIZE_LIMIT } },
            { name: "runtime-temp", emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * Reads the Job created for one durable operation attempt. Filtering by both
 * the backup ID and attempt ID prevents a stale reconciler from observing a
 * newer retry's Job.
 */
export async function getBackupJobState(
  backupId: string,
  serverId: string,
  namespace: string,
  operation: "create" | "restore" | "delete",
  attemptId: string,
  operationStartedAt: Date | null,
): Promise<BackupJobState> {
  const { batch } = makeKubernetesClients();
  const jobs = await Promise.all(
    backupJobLookupNamespaces(namespace, attemptId).map((lookupNamespace) =>
      batch.listNamespacedJob({
        namespace: lookupNamespace,
        labelSelector: `farlands.dev/backup-id=${backupId}`,
      }),
    ),
  );

  const job = selectBackupJobForAttempt(
    jobs.flatMap((result) => result.items),
    serverId,
    backupId,
    operation,
    attemptId,
    operationStartedAt,
  );

  if (!job?.metadata?.name) return { status: "missing" };

  const observedOperation = job.metadata.labels?.["farlands.dev/backup-operation"];
  if (!observedOperation) return { status: "pending" };

  if (
    job.status?.conditions?.some(
      (condition) => condition.type === "Complete" && condition.status === "True",
    )
  ) {
    const storagePath =
      operation === "create" && legacyBackupOperationAttempt(attemptId)
        ? legacyCreateJobStoragePath(job, serverId, attemptId, resolveBackupStorageConfig().prefix)
        : null;
    return {
      status: "completed",
      jobName: job.metadata.name,
      operation: observedOperation,
      ...(storagePath ? { storagePath } : {}),
    };
  }

  if (
    job.status?.conditions?.some(
      (condition) => condition.type === "Failed" && condition.status === "True",
    )
  ) {
    return { status: "failed", jobName: job.metadata.name, operation: observedOperation };
  }

  return { status: "pending" };
}
