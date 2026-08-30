import type * as k8s from "@kubernetes/client-node";
import { makeKubernetesClients } from "../../lib/k8s";

const DEFAULT_LEASE_SECONDS = 3 * 60 * 60;
const DEFAULT_DISPATCH_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_RELEASE_ATTEMPTS = 3;
const DEFAULT_RELEASE_BACKOFF_MS = 100;
export const BACKUP_RECONCILIATION_LEASE_SECONDS = 5 * 60;

// Synchronous control-plane operations have bounded readiness waits (at most
// two three-minute waits for restart). Keep enough margin for API calls and
// compensation while ensuring a crashed random holder cannot block backups for
// the three-hour lifetime used by asynchronous backup Jobs.
export const SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS = 15 * 60;

type BackupLeaseReleaseRetryOptions = {
  attempts?: number;
  initialBackoffMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

type BackupLeaseClient = Pick<
  ReturnType<typeof makeKubernetesClients>["coordination"],
  | "createNamespacedLease"
  | "readNamespacedLease"
  | "replaceNamespacedLease"
  | "deleteNamespacedLease"
>;

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

export class BackupOperationBusyError extends Error {
  constructor(serverId: string) {
    super(`Another backup or restore operation is already active for server '${serverId}'`);
    this.name = "BackupOperationBusyError";
  }
}

export class BackupLeaseAcquisitionUncertainError extends Error {
  constructor(serverId: string, options?: ErrorOptions) {
    super(`Could not confirm backup Lease ownership for server '${serverId}'`, options);
    this.name = "BackupLeaseAcquisitionUncertainError";
  }
}

export function kubernetesLeaseMutationErrorIsAmbiguous(error: unknown): boolean {
  const code = kubernetesStatusCode(error);
  return code === undefined || code === 408 || code === 429 || code >= 500;
}

export function backupLeaseName(serverId: string): string {
  return `backup-operation-${serverId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

export function backupLeaseExpired(lease: k8s.V1Lease, now = new Date()): boolean {
  const renewedAt = lease.spec?.renewTime ?? lease.spec?.acquireTime;
  const durationSeconds = lease.spec?.leaseDurationSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!renewedAt) return true;
  return renewedAt.getTime() + durationSeconds * 1_000 <= now.getTime();
}

export function assertBackupLeaseFence(confirmedUntil: number, now = Date.now()): void {
  if (now >= confirmedUntil) {
    throw new Error("Backup Lease ownership window expired");
  }
}

export function assertBackupLeaseRemaining(
  confirmedUntil: number,
  requiredRemainingMs: number,
  now = Date.now(),
): void {
  assertBackupLeaseFence(confirmedUntil, now);
  if (
    !Number.isFinite(requiredRemainingMs) ||
    requiredRemainingMs <= 0 ||
    confirmedUntil - now < requiredRemainingMs
  ) {
    throw new Error("Backup Lease does not cover the worker Job deadline");
  }
}

export function assertBackupLeaseRenewalFence(
  previousConfirmedUntil: number,
  renewedConfirmedUntil: number,
  requestStartedAt: number,
  responseReceivedAt: number,
): void {
  assertBackupLeaseFence(previousConfirmedUntil, requestStartedAt);
  if (responseReceivedAt >= previousConfirmedUntil) {
    throw new Error("Backup Lease renewal completed after its prior ownership window expired");
  }
  assertBackupLeaseFence(renewedConfirmedUntil, responseReceivedAt);
}

export function backupOperationDispatchExpired(
  operationStartedAt: Date | null,
  recordCreatedAt: Date,
  now = new Date(),
  graceMs = DEFAULT_DISPATCH_GRACE_MS,
): boolean {
  const claimedAt = operationStartedAt ?? recordCreatedAt;
  return claimedAt.getTime() + graceMs <= now.getTime();
}

function leaseBody(
  namespace: string,
  serverId: string,
  holderIdentity: string,
  now: Date,
  leaseDurationSeconds: number,
): k8s.V1Lease {
  return {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: backupLeaseName(serverId),
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "farlands",
        "app.kubernetes.io/component": "backup",
        "farlands.dev/server-id": serverId,
      },
    },
    spec: {
      holderIdentity,
      leaseDurationSeconds,
      acquireTime: now as k8s.V1MicroTime,
      renewTime: now as k8s.V1MicroTime,
      leaseTransitions: 0,
    },
  };
}

function leaseTimeMillis(value: k8s.V1MicroTime | undefined): number | null {
  if (!value) return null;
  const millis =
    value instanceof Date ? value.getTime() : new Date(value as unknown as string).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function acceptedBackupLeaseDeadline(
  accepted: k8s.V1Lease,
  desired: k8s.V1Lease,
  previousResourceVersion?: string,
): Date | null {
  const acceptedTime = leaseTimeMillis(accepted.spec?.renewTime ?? accepted.spec?.acquireTime);
  const desiredTime = leaseTimeMillis(desired.spec?.renewTime ?? desired.spec?.acquireTime);
  const acceptedDuration = accepted.spec?.leaseDurationSeconds ?? 0;
  const desiredDuration = desired.spec?.leaseDurationSeconds ?? 0;
  const resourceVersionAdvanced =
    previousResourceVersion !== undefined &&
    accepted.metadata?.resourceVersion !== undefined &&
    accepted.metadata.resourceVersion !== previousResourceVersion;
  if (
    accepted.spec?.holderIdentity !== desired.spec?.holderIdentity ||
    acceptedDuration < desiredDuration ||
    acceptedTime === null ||
    desiredTime === null ||
    acceptedTime < desiredTime ||
    (previousResourceVersion !== undefined && !resourceVersionAdvanced)
  ) {
    return null;
  }
  return new Date(acceptedTime + acceptedDuration * 1_000);
}

export async function acquireBackupLease(
  namespace: string,
  serverId: string,
  holderIdentity: string,
  leaseDurationSeconds = DEFAULT_LEASE_SECONDS,
  coordinationClient?: BackupLeaseClient,
): Promise<Date> {
  const coordination = coordinationClient ?? makeKubernetesClients().coordination;
  const name = backupLeaseName(serverId);
  const now = new Date();
  const desired = leaseBody(namespace, serverId, holderIdentity, now, leaseDurationSeconds);

  try {
    const accepted = await coordination.createNamespacedLease({ namespace, body: desired });
    const deadline = acceptedBackupLeaseDeadline(accepted, desired);
    if (!deadline) {
      throw new BackupLeaseAcquisitionUncertainError(serverId, {
        cause: new Error("Lease create response did not confirm the requested ownership window"),
      });
    }
    return deadline;
  } catch (error) {
    const code = kubernetesStatusCode(error);
    if (code !== 409) {
      if (!kubernetesLeaseMutationErrorIsAmbiguous(error)) throw error;
      try {
        const accepted = await coordination.readNamespacedLease({ name, namespace });
        const deadline = acceptedBackupLeaseDeadline(accepted, desired);
        if (deadline) return deadline;
        if (!backupLeaseExpired(accepted, now)) throw new BackupOperationBusyError(serverId);
      } catch (readError) {
        if (readError instanceof BackupOperationBusyError) throw readError;
        throw new BackupLeaseAcquisitionUncertainError(serverId, { cause: readError });
      }
    }
  }

  const existing = await coordination.readNamespacedLease({ name, namespace });
  const sameHolder = existing.spec?.holderIdentity === holderIdentity;
  if (!sameHolder && !backupLeaseExpired(existing, now)) {
    throw new BackupOperationBusyError(serverId);
  }

  desired.metadata!.resourceVersion = existing.metadata?.resourceVersion;
  desired.spec!.leaseTransitions = sameHolder
    ? (existing.spec?.leaseTransitions ?? 0)
    : (existing.spec?.leaseTransitions ?? 0) + 1;

  try {
    const accepted = await coordination.replaceNamespacedLease({ name, namespace, body: desired });
    const deadline = acceptedBackupLeaseDeadline(
      accepted,
      desired,
      existing.metadata?.resourceVersion,
    );
    if (!deadline) {
      throw new BackupLeaseAcquisitionUncertainError(serverId, {
        cause: new Error("Lease replace response did not confirm the requested ownership window"),
      });
    }
    return deadline;
  } catch (error) {
    if (kubernetesStatusCode(error) === 409) throw new BackupOperationBusyError(serverId);
    if (kubernetesLeaseMutationErrorIsAmbiguous(error)) {
      try {
        const accepted = await coordination.readNamespacedLease({ name, namespace });
        const deadline = acceptedBackupLeaseDeadline(
          accepted,
          desired,
          existing.metadata?.resourceVersion,
        );
        if (deadline) return deadline;
        if (!backupLeaseExpired(accepted, now)) throw new BackupOperationBusyError(serverId);
      } catch (readError) {
        if (readError instanceof BackupOperationBusyError) throw readError;
        throw new BackupLeaseAcquisitionUncertainError(serverId, { cause: readError });
      }
    }
    throw error;
  }
}

export async function releaseBackupLease(
  namespace: string,
  serverId: string,
  holderIdentity: string,
): Promise<boolean> {
  const { coordination } = makeKubernetesClients();
  const name = backupLeaseName(serverId);
  let existing: k8s.V1Lease;

  try {
    existing = await coordination.readNamespacedLease({ name, namespace });
  } catch (error) {
    if (kubernetesStatusCode(error) === 404) return true;
    throw error;
  }

  // The desired holder no longer owns the Lease, so this release is already
  // complete. Never delete a successor's Lease.
  if (existing.spec?.holderIdentity !== holderIdentity) return true;

  try {
    await coordination.deleteNamespacedLease({
      name,
      namespace,
      body: {
        preconditions: {
          resourceVersion: existing.metadata?.resourceVersion,
          uid: existing.metadata?.uid,
        },
      },
    });
    return true;
  } catch (error) {
    const statusCode = kubernetesStatusCode(error);
    if (statusCode === 404) return true;
    // A resource-version conflict is safe to retry: the next attempt re-reads
    // the Lease and will stop if another holder has taken ownership.
    if (statusCode === 409) return false;
    throw error;
  }
}

export async function retryBackupLeaseRelease(
  release: () => Promise<boolean>,
  {
    attempts = DEFAULT_RELEASE_ATTEMPTS,
    initialBackoffMs = DEFAULT_RELEASE_BACKOFF_MS,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }: BackupLeaseReleaseRetryOptions = {},
): Promise<void> {
  const boundedAttempts = Math.max(1, Math.floor(attempts));
  const boundedInitialBackoffMs = Math.max(0, initialBackoffMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      if (await release()) return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < boundedAttempts) {
      await sleep(boundedInitialBackoffMs * 2 ** (attempt - 1));
    }
  }

  if (lastError) throw lastError;
  throw new Error(`Backup Lease release conflicted after ${boundedAttempts} attempts`);
}

export async function releaseBackupLeaseWithRetry(
  namespace: string,
  serverId: string,
  holderIdentity: string,
  options?: BackupLeaseReleaseRetryOptions,
): Promise<void> {
  await retryBackupLeaseRelease(
    () => releaseBackupLease(namespace, serverId, holderIdentity),
    options,
  );
}

export function legacyBackupOperationAttempt(attemptId: string): boolean {
  return attemptId.startsWith("legacy-");
}

export function backupLeaseHolder(
  operation: "create" | "restore" | "delete",
  backupId: string,
  attemptId: string,
) {
  const operationHolder = `api:${operation}:${backupId}`;
  // Operations recovered by migration 0015 predate attempt-scoped Lease
  // holders. Preserve their old identity until that one legacy attempt has
  // reconciled; every new attempt uses its durable UUID.
  return legacyBackupOperationAttempt(attemptId)
    ? operationHolder
    : `${operationHolder}:${attemptId}`;
}

export function backupReconciliationLeaseHolder(
  operation: "create" | "restore" | "delete",
  attemptId: string,
  reconciliationId: string,
): string {
  return `reconcile:${operation}:${attemptId}:${reconciliationId}`;
}
