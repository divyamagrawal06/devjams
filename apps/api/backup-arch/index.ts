import * as k8s from "@kubernetes/client-node";

const SERVER_ID_LABEL = "farlands.dev/server-id";
const BACKUP_SERVER_ID_LABEL = "farlands.dev/backup-server-id";
const BACKUP_SERVICE_ANNOTATION = "farlands.dev/backup-service";
const BACKUP_STRATEGY_LABEL = "farlands.dev/backup-strategy";
const MINECRAFT_RCON_BACKUP_STRATEGY = "minecraft-rcon";
const BACKUP_RUN_LABEL = "farlands.dev/backup-run";
const BACKUP_INVOCATION_ANNOTATION = "farlands.dev/backup-orchestrator-invocation";
const BACKUP_WORKER_ROLE_ANNOTATION = "eks.amazonaws.com/role-arn";
const DEFAULT_PVC_PAGE_SIZE = 500;
const LEASE_ACQUISITION_TTL_SECONDS = 60;
const WORKER_LEASE_HEADROOM_SECONDS = 30 * 60;
const WORKER_LEASE_TERMINATION_MARGIN_SECONDS = 5 * 60;
const FAILED_JOB_DELETE_TIMEOUT_MS = 5 * 60 * 1_000;
const FAILED_JOB_DELETE_POLL_INTERVAL_MS = 1_000;

export type BackupConfig = {
  labelSelector: string;
  bucket: string;
  region: string;
  prefix: string;
  archiveImage: string;
  uploadImage: string;
  workerServiceAccount: string;
  workerRoleArn: string;
  retentionCount: number;
  maxConcurrency: number;
  workerActiveDeadlineSeconds: number;
  workerPollIntervalMs: number;
  tempSizeLimit: string;
};

export type BackupTarget = {
  namespace: string;
  pvcName: string;
  serverId: string;
  serviceName?: string;
  workloadLabel?: string;
  nodeName?: string;
};

export function weeklyJobMatchesRun(
  job: k8s.V1Job,
  serverId: string,
  runId: string,
): boolean {
  const labels = job.metadata?.labels;
  return (
    labels?.[SERVER_ID_LABEL] === serverId &&
    labels?.[BACKUP_RUN_LABEL] === runId &&
    labels?.["farlands.dev/backup-schedule"] === "weekly"
  );
}

type KubernetesClients = {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
  batch: k8s.BatchV1Api;
  coordination: k8s.CoordinationV1Api;
};

export type ServerWorkloadState =
  | { mode: "running"; nodeName: string }
  | { mode: "stopped" }
  | { mode: "unsafe"; reason: string };

function requireEnv(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parsePositiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || `${parsed}` !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)) {
    throw new Error(
      "S3_PREFIX must be a non-empty relative key prefix containing only letters, numbers, '.', '_', '-', and '/'",
    );
  }
  return prefix;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): BackupConfig {
  return {
    labelSelector: requireEnv(environment, "PVC_LABEL_SELECTOR"),
    bucket: requireEnv(environment, "S3_BUCKET"),
    region: requireEnv(environment, "S3_REGION"),
    prefix: normalizePrefix(requireEnv(environment, "S3_PREFIX")),
    archiveImage: requireEnv(environment, "BACKUP_IMAGE_ARCHIVE"),
    uploadImage: requireEnv(environment, "BACKUP_IMAGE_UPLOAD"),
    workerServiceAccount: requireEnv(environment, "BACKUP_WORKER_SERVICE_ACCOUNT"),
    workerRoleArn: requireEnv(environment, "BACKUP_WORKER_ROLE_ARN"),
    retentionCount: parsePositiveInteger(environment, "BACKUP_RETENTION_COUNT", 3),
    maxConcurrency: parsePositiveInteger(environment, "BACKUP_MAX_CONCURRENCY", 3),
    workerActiveDeadlineSeconds: parsePositiveInteger(
      environment,
      "BACKUP_WORKER_ACTIVE_DEADLINE_SECONDS",
      7_200,
    ),
    workerPollIntervalMs:
      parsePositiveInteger(environment, "BACKUP_WORKER_POLL_INTERVAL_SECONDS", 10) * 1_000,
    tempSizeLimit: environment.BACKUP_TEMP_SIZE_LIMIT?.trim() || "25Gi",
  };
}

function sanitizeJobName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

/** Return an id such as 2026-w35. A retry in the same UTC week is idempotent. */
export function weeklyRunId(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDay = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - isoDay);
  const isoYear = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-w${String(week).padStart(2, "0")}`;
}

/**
 * The archive key and worker Job remain stable for an ISO week, but Lease
 * ownership must identify one orchestrator process. Otherwise two overlapping
 * invocations can both appear to own the same Lease and release it for each
 * other while a worker is still active.
 */
export function weeklyLeaseHolder(runId: string, invocationId: string): string {
  const normalizedInvocationId = invocationId.trim().toLowerCase();
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62}[a-z0-9])?$/.test(normalizedInvocationId)) {
    throw new Error(
      "BACKUP_ORCHESTRATOR_INVOCATION_ID must be a DNS-safe identifier up to 64 characters",
    );
  }
  return `weekly:${runId}:${normalizedInvocationId}`;
}

export function resolveWeeklyInvocationId(
  environment: Record<string, string | undefined> = process.env,
): string {
  return environment.BACKUP_ORCHESTRATOR_INVOCATION_ID?.trim() || crypto.randomUUID();
}

function statusCode(error: unknown): number | undefined {
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
  const code = statusCode(error);
  return code === undefined || code === 408 || code === 429 || code >= 500;
}

export function targetFromPvc(pvc: k8s.V1PersistentVolumeClaim): BackupTarget {
  const namespace = pvc.metadata?.namespace;
  const pvcName = pvc.metadata?.name;
  const backupServerId = pvc.metadata?.labels?.[BACKUP_SERVER_ID_LABEL];
  const legacyServerId = pvc.metadata?.labels?.[SERVER_ID_LABEL];
  const serverId = backupServerId ?? legacyServerId;
  const serviceName = pvc.metadata?.annotations?.[BACKUP_SERVICE_ANNOTATION];

  if (!namespace || !pvcName || !serverId) {
    throw new Error(
      `PVC '${namespace ?? "<missing-namespace>"}/${pvcName ?? "<missing-name>"}' is missing namespace, name, or ${SERVER_ID_LABEL}`,
    );
  }

  return {
    namespace,
    pvcName,
    serverId,
    serviceName: validatedBackupServiceName(serviceName, serverId),
    workloadLabel: backupServerId ? BACKUP_SERVER_ID_LABEL : SERVER_ID_LABEL,
  };
}

function validatedBackupServiceName(serviceName: string | undefined, serverId: string): string {
  const candidate = serviceName ?? `svc-server-${serverId}`;
  const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  if (candidate.length > 63 || !dnsLabel.test(candidate)) {
    throw new Error(
      `${BACKUP_SERVICE_ANNOTATION} must be a Kubernetes DNS label up to 63 characters`,
    );
  }
  return candidate;
}

/** Re-resolve the unique active volume after the per-server Lease is held. */
export async function resolveLeasedBackupTarget(
  core: Pick<k8s.CoreV1Api, "listNamespacedPersistentVolumeClaim">,
  discoveredTarget: BackupTarget,
): Promise<BackupTarget> {
  const activePvcs = await core.listNamespacedPersistentVolumeClaim({
    namespace: discoveredTarget.namespace,
    labelSelector: `${BACKUP_STRATEGY_LABEL}=${MINECRAFT_RCON_BACKUP_STRATEGY}`,
  });
  const matchingPvcs = activePvcs.items.filter(
    (pvc) => pvc.metadata?.labels?.[BACKUP_SERVER_ID_LABEL] === discoveredTarget.serverId,
  );
  if (matchingPvcs.length !== 1) {
    throw new Error(
      `Expected exactly one active backup PVC for '${discoveredTarget.serverId}' under its Lease, found ${matchingPvcs.length}`,
    );
  }

  const leasedTarget = targetFromPvc(matchingPvcs[0]);
  if (
    leasedTarget.namespace !== discoveredTarget.namespace ||
    leasedTarget.serverId !== discoveredTarget.serverId ||
    leasedTarget.workloadLabel !== BACKUP_SERVER_ID_LABEL
  ) {
    throw new Error(`Active backup PVC identity changed for '${discoveredTarget.serverId}'`);
  }
  return leasedTarget;
}

export function backupLeaseName(serverId: string): string {
  return sanitizeJobName(`backup-operation-${serverId}`);
}

export function backupLeaseExpired(lease: k8s.V1Lease, now = new Date()): boolean {
  const renewedAt = lease.spec?.renewTime ?? lease.spec?.acquireTime;
  const durationSeconds = lease.spec?.leaseDurationSeconds ?? 7_500;
  if (!renewedAt) return true;
  return renewedAt.getTime() + durationSeconds * 1_000 <= now.getTime();
}

export function weeklyLeaseReflectsMutation(
  lease: k8s.V1Lease,
  holderIdentity: string,
  durationSeconds: number,
  attemptedAt: Date,
): boolean {
  const renewedAt = lease.spec?.renewTime ?? lease.spec?.acquireTime;
  return (
    lease.spec?.holderIdentity === holderIdentity &&
    (lease.spec?.leaseDurationSeconds ?? 0) >= durationSeconds &&
    renewedAt !== undefined &&
    renewedAt.getTime() >= attemptedAt.getTime()
  );
}

async function acquireBackupLease(
  coordination: k8s.CoordinationV1Api,
  target: BackupTarget,
  holderIdentity: string,
  durationSeconds: number,
): Promise<Date> {
  const name = backupLeaseName(target.serverId);
  const now = new Date();
  const desired: k8s.V1Lease = {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name,
      namespace: target.namespace,
      labels: {
        "app.kubernetes.io/part-of": "farlands",
        "app.kubernetes.io/component": "backup",
        [SERVER_ID_LABEL]: target.serverId,
      },
    },
    spec: {
      holderIdentity,
      leaseDurationSeconds: durationSeconds,
      acquireTime: now as k8s.V1MicroTime,
      renewTime: now as k8s.V1MicroTime,
      leaseTransitions: 0,
    },
  };

  let existing: k8s.V1Lease | undefined;
  const acquisitionLease: k8s.V1Lease = {
    ...desired,
    spec: {
      ...desired.spec,
      leaseDurationSeconds: Math.min(durationSeconds, LEASE_ACQUISITION_TTL_SECONDS),
    },
  };
  try {
    existing = await coordination.createNamespacedLease({
      namespace: target.namespace,
      body: acquisitionLease,
    });
  } catch (error) {
    if (statusCode(error) !== 409 && !kubernetesCreateErrorIsAmbiguous(error)) throw error;
    try {
      existing = await coordination.readNamespacedLease({
        name,
        namespace: target.namespace,
      });
    } catch (readError) {
      const uncertain = new Error(
        `Could not confirm weekly backup Lease ownership for server '${target.serverId}'`,
      );
      (uncertain as Error & { cause?: unknown }).cause = readError;
      throw uncertain;
    }
  }

  if (!existing) {
    existing = await coordination.readNamespacedLease({
      name,
      namespace: target.namespace,
    });
  }
  const sameHolder = existing.spec?.holderIdentity === holderIdentity;
  if (!sameHolder && !backupLeaseExpired(existing, now)) {
    throw new Error(
      `Server '${target.serverId}' already has backup operation '${existing.spec?.holderIdentity ?? "unknown"}'`,
    );
  }

  const promotionTime = new Date();
  desired.metadata!.resourceVersion = existing.metadata?.resourceVersion;
  desired.spec!.renewTime = promotionTime as k8s.V1MicroTime;
  desired.spec!.acquireTime = sameHolder
    ? (existing.spec?.acquireTime ?? (promotionTime as k8s.V1MicroTime))
    : (promotionTime as k8s.V1MicroTime);
  desired.spec!.leaseTransitions = sameHolder
    ? (existing.spec?.leaseTransitions ?? 0)
    : (existing.spec?.leaseTransitions ?? 0) + 1;

  try {
    const accepted = await coordination.replaceNamespacedLease({
      name,
      namespace: target.namespace,
      body: desired,
    });
    const acceptedTime = accepted.spec?.renewTime ?? accepted.spec?.acquireTime;
    return new Date(
      (acceptedTime?.getTime() ?? promotionTime.getTime()) + durationSeconds * 1_000,
    );
  } catch (error) {
    if (statusCode(error) === 409) {
      throw new Error(`Server '${target.serverId}' was claimed by another backup operation`);
    }
    if (kubernetesCreateErrorIsAmbiguous(error)) {
      try {
        const accepted = await coordination.readNamespacedLease({
          name,
          namespace: target.namespace,
        });
        if (
          weeklyLeaseReflectsMutation(
            accepted,
            holderIdentity,
            durationSeconds,
            promotionTime,
          )
        ) {
          const acceptedTime = accepted.spec?.renewTime ?? accepted.spec?.acquireTime;
          return new Date(acceptedTime!.getTime() + durationSeconds * 1_000);
        }
      } catch (readError) {
        const uncertain = new Error(
          `Could not confirm replaced weekly backup Lease ownership for server '${target.serverId}'`,
        );
        (uncertain as Error & { cause?: unknown }).cause = readError;
        throw uncertain;
      }
      throw new Error(`Server '${target.serverId}' was claimed by another backup operation`);
    }
    throw error;
  }
}

export async function releaseWeeklyBackupLease(
  coordination: k8s.CoordinationV1Api,
  target: BackupTarget,
  holderIdentity: string,
): Promise<boolean> {
  const name = backupLeaseName(target.serverId);
  let existing: k8s.V1Lease;
  try {
    existing = await coordination.readNamespacedLease({ name, namespace: target.namespace });
  } catch (error) {
    if (statusCode(error) === 404) return true;
    throw error;
  }
  if (existing.spec?.holderIdentity !== holderIdentity) return true;

  try {
    await coordination.deleteNamespacedLease({
      name,
      namespace: target.namespace,
      body: {
        preconditions: {
          resourceVersion: existing.metadata?.resourceVersion,
          uid: existing.metadata?.uid,
        },
      },
    });
    return true;
  } catch (error) {
    if (statusCode(error) === 404) return true;
    if (statusCode(error) === 409) return false;
    throw error;
  }
}

export async function retryWeeklyLeaseRelease(
  release: () => Promise<boolean>,
  {
    attempts = 5,
    initialBackoffMs = 250,
    sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  }: {
    attempts?: number;
    initialBackoffMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const boundedAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      if (await release()) return;
    } catch (error) {
      lastError = error;
    }
    if (attempt < boundedAttempts) {
      await sleep(Math.max(0, initialBackoffMs) * 2 ** (attempt - 1));
    }
  }
  if (lastError) throw lastError;
  throw new Error(`Weekly backup Lease release conflicted after ${boundedAttempts} attempts`);
}

async function releaseBackupLeaseWithRetry(
  coordination: k8s.CoordinationV1Api,
  target: BackupTarget,
  holderIdentity: string,
): Promise<void> {
  await retryWeeklyLeaseRelease(() =>
    releaseWeeklyBackupLease(coordination, target, holderIdentity),
  );
}

export function buildBackupJob(
  target: BackupTarget,
  config: BackupConfig,
  runId: string,
  invocationId?: string,
): k8s.V1Job {
  const jobName = sanitizeJobName(`backup-${target.serverId}-${runId}`);
  const archiveFile = `${target.serverId}-weekly-${runId}.tar.gz`;
  const weeklyPrefix = `${config.prefix}/${target.serverId}/weekly/`;
  const storageKey = `${weeklyPrefix}${archiveFile}`;
  const serviceName = validatedBackupServiceName(target.serviceName, target.serverId);
  const backupEndpoint = `http://${serviceName}:8080/backup`;
  const archiveCommand = target.nodeName
    ? 'set -eu; wget --quiet --output-document "/backup/${ARCHIVE_FILE}" --post-data="" "${BACKUP_ENDPOINT}"; test -s "/backup/${ARCHIVE_FILE}"; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -q .; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -Eq "^\\./(server\\.properties|world/level\\.dat|level\\.dat)$"'
    : 'set -eu; if [ -d /world/.farlands-restore-rollback ] && [ -n "$(find /world/.farlands-restore-rollback -mindepth 1 -print -quit)" ]; then echo "Manual restore recovery data must be resolved before backup" >&2; exit 1; fi; tar --exclude="./.farlands-restore-staging" --exclude="./.farlands-restore-rollback" -czf "/backup/${ARCHIVE_FILE}" -C /world .; test -s "/backup/${ARCHIVE_FILE}"; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -q .; tar -tzf "/backup/${ARCHIVE_FILE}" | grep -Eq "^\\./(server\\.properties|world/level\\.dat|level\\.dat)$"';

  const restrictedContainerSecurityContext: k8s.V1SecurityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    capabilities: { drop: ["ALL"] },
  };

  return {
    metadata: {
      name: jobName,
      namespace: target.namespace,
      labels: {
        app: "server-backup-worker",
        [SERVER_ID_LABEL]: target.serverId,
        [BACKUP_RUN_LABEL]: runId,
        "farlands.dev/backup-schedule": "weekly",
      },
      annotations: {
        "farlands.dev/backup-storage-key": storageKey,
        ...(invocationId ? { [BACKUP_INVOCATION_ANNOTATION]: invocationId } : {}),
      },
    },
    spec: {
      ttlSecondsAfterFinished: 7 * 24 * 60 * 60,
      activeDeadlineSeconds: config.workerActiveDeadlineSeconds,
      backoffLimit: 1,
      template: {
        metadata: {
          labels: {
            app: "server-backup-worker",
            [SERVER_ID_LABEL]: target.serverId,
            [BACKUP_RUN_LABEL]: runId,
            "farlands.dev/backup-schedule": "weekly",
          },
        },
        spec: {
          serviceAccountName: config.workerServiceAccount,
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
          ...(target.nodeName
            ? { nodeSelector: { "kubernetes.io/hostname": target.nodeName } }
            : {}),
          initContainers: [
            {
              name: "create-and-validate-backup",
              image: config.archiveImage,
              imagePullPolicy: "IfNotPresent",
              command: [
                "/bin/sh",
                "-c",
                archiveCommand,
              ],
              env: [
                { name: "ARCHIVE_FILE", value: archiveFile },
                { name: "BACKUP_ENDPOINT", value: backupEndpoint },
              ],
              resources: {
                requests: {
                  cpu: "100m",
                  memory: "128Mi",
                  "ephemeral-storage": "1Gi",
                },
                limits: {
                  cpu: "1",
                  memory: "512Mi",
                  "ephemeral-storage": config.tempSizeLimit,
                },
              },
              securityContext: restrictedContainerSecurityContext,
              volumeMounts: [
                ...(target.nodeName
                  ? []
                  : [{ name: "server-data", mountPath: "/world", readOnly: true }]),
                { name: "backup-temp", mountPath: "/backup" },
              ],
            },
          ],
          containers: [
            {
              name: "upload-verify-and-prune",
              image: config.uploadImage,
              imagePullPolicy: "IfNotPresent",
              command: [
                "/bin/sh",
                "-c",
                [
                  "set -eu",
                  'aws s3 cp "/backup/${ARCHIVE_FILE}" "s3://${BACKUP_BUCKET}/${STORAGE_KEY}" --region "${AWS_REGION}" --sse AES256 --checksum-algorithm SHA256 --content-type application/gzip --metadata "backup-schedule=weekly,server-id=${SERVER_ID}" --no-progress --only-show-errors',
                  'REMOTE_CHECKSUM="$(aws s3api head-object --bucket "${BACKUP_BUCKET}" --key "${STORAGE_KEY}" --region "${AWS_REGION}" --checksum-mode ENABLED --query ChecksumSHA256 --output text)"',
                  'if [ -z "${REMOTE_CHECKSUM}" ] || [ "${REMOTE_CHECKSUM}" = "None" ]; then echo "S3 did not return the uploaded SHA-256 checksum" >&2; exit 1; fi',
                  'STALE_KEYS="$(aws s3api list-objects-v2 --bucket "${BACKUP_BUCKET}" --prefix "${WEEKLY_PREFIX}" --region "${AWS_REGION}" --query "reverse(sort_by(Contents,&LastModified))[${BACKUP_RETENTION_COUNT}:].Key" --output text)"',
                  'if [ -n "${STALE_KEYS}" ] && [ "${STALE_KEYS}" != "None" ]; then for key in ${STALE_KEYS}; do aws s3api delete-object --bucket "${BACKUP_BUCKET}" --key "${key}" --region "${AWS_REGION}" >/dev/null; done; fi',
                ].join("; "),
              ],
              env: [
                { name: "ARCHIVE_FILE", value: archiveFile },
                { name: "BACKUP_BUCKET", value: config.bucket },
                { name: "STORAGE_KEY", value: storageKey },
                { name: "WEEKLY_PREFIX", value: weeklyPrefix },
                { name: "AWS_REGION", value: config.region },
                { name: "SERVER_ID", value: target.serverId },
                { name: "BACKUP_RETENTION_COUNT", value: `${config.retentionCount}` },
                { name: "HOME", value: "/tmp" },
              ],
              resources: {
                requests: {
                  cpu: "50m",
                  memory: "128Mi",
                  "ephemeral-storage": "1Gi",
                },
                limits: {
                  cpu: "500m",
                  memory: "512Mi",
                  "ephemeral-storage": config.tempSizeLimit,
                },
              },
              securityContext: restrictedContainerSecurityContext,
              volumeMounts: [
                { name: "backup-temp", mountPath: "/backup", readOnly: true },
                { name: "runtime-temp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            ...(target.nodeName
              ? []
              : [
                  {
                    name: "server-data",
                    persistentVolumeClaim: { claimName: target.pvcName },
                  },
                ]),
            {
              name: "backup-temp",
              emptyDir: { sizeLimit: config.tempSizeLimit },
            },
            { name: "runtime-temp", emptyDir: {} },
          ],
        },
      },
    },
  };
}

async function listManagedPvcs(
  core: k8s.CoreV1Api,
  labelSelector: string,
): Promise<k8s.V1PersistentVolumeClaim[]> {
  const pvcs: k8s.V1PersistentVolumeClaim[] = [];
  let continueToken: string | undefined;

  do {
    const page = await core.listPersistentVolumeClaimForAllNamespaces({
      labelSelector,
      limit: DEFAULT_PVC_PAGE_SIZE,
      _continue: continueToken,
    });
    pvcs.push(...page.items);
    continueToken = page.metadata?._continue;
  } while (continueToken);

  return pvcs;
}

async function requireWorkerIdentity(
  core: k8s.CoreV1Api,
  namespace: string,
  serviceAccount: string,
  roleArn: string,
): Promise<void> {
  let identity: k8s.V1ServiceAccount;
  try {
    identity = await core.readNamespacedServiceAccount({ name: serviceAccount, namespace });
  } catch (error) {
    if (statusCode(error) === 404) {
      throw new Error(
        `Worker ServiceAccount '${namespace}/${serviceAccount}' is missing. Realm provisioning must create its IRSA identity before weekly backups can run.`,
      );
    }
    throw error;
  }

  if (!workerIdentityMatches(identity, roleArn)) {
    throw new Error(
      `Worker ServiceAccount '${namespace}/${serviceAccount}' does not have the managed IRSA role or has its Kubernetes API token enabled; apply the backup Terraform stack and reconcile the tenant namespace`,
    );
  }
}

export function workerIdentityMatches(identity: k8s.V1ServiceAccount, roleArn: string): boolean {
  return (
    identity.metadata?.annotations?.[BACKUP_WORKER_ROLE_ANNOTATION] === roleArn &&
    identity.automountServiceAccountToken === false
  );
}

function podIsReady(pod: k8s.V1Pod): boolean {
  return pod.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ) === true;
}

export function classifyServerWorkload(
  deployments: k8s.V1Deployment[],
  pods: k8s.V1Pod[],
): ServerWorkloadState {
  if (deployments.length !== 1) {
    return {
      mode: "unsafe",
      reason: `expected exactly one managed Deployment, found ${deployments.length}`,
    };
  }

  const desiredReplicas = deployments[0]?.spec?.replicas ?? 1;
  const activePods = pods.filter(
    (pod) => pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed",
  );

  if (desiredReplicas === 0 && activePods.length === 0) return { mode: "stopped" };

  if (desiredReplicas === 1 && activePods.length === 1) {
    const [pod] = activePods;
    const nodeName = pod?.spec?.nodeName;
    if (
      pod?.status?.phase === "Running" &&
      nodeName &&
      !pod.metadata?.deletionTimestamp &&
      podIsReady(pod)
    ) {
      return { mode: "running", nodeName };
    }
  }

  return {
    mode: "unsafe",
    reason: `Deployment desires ${desiredReplicas} replica(s) with ${activePods.length} nonterminal pod(s)`,
  };
}

async function serverWorkloadState(
  clients: Pick<KubernetesClients, "core" | "apps">,
  namespace: string,
  serverId: string,
  workloadLabel: string,
): Promise<ServerWorkloadState> {
  const labelSelector = `${workloadLabel}=${serverId}`;
  const [deployments, pods] = await Promise.all([
    clients.apps.listNamespacedDeployment({ namespace, labelSelector }),
    clients.core.listNamespacedPod({ namespace, labelSelector }),
  ]);
  return classifyServerWorkload(deployments.items, pods.items);
}

type WeeklyJobClient = Pick<
  k8s.BatchV1Api,
  "createNamespacedJob" | "readNamespacedJob" | "deleteNamespacedJob"
>;

export type WeeklyJobCreateOutcome = "created" | "reused" | "ambiguous" | "retried";

type FailedJobReplacementOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  beforeCreate?: () => Promise<Date>;
  beforeDelete?: () => Promise<Date>;
  requiredRemainingMs?: number;
};

class WeeklyJobReplacementUncertainError extends Error {
  constructor(namespace: string, jobName: string, cause?: unknown) {
    super(
      `Could not confirm deletion of failed weekly Job '${namespace}/${jobName}'; retaining its Lease`,
    );
    this.name = "WeeklyJobReplacementUncertainError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

function weeklyJobCondition(
  job: k8s.V1Job,
  type: "Complete" | "Failed",
): boolean {
  return job.status?.conditions?.some(
    (condition) => condition.type === type && condition.status === "True",
  ) === true;
}

export function weeklyJobTerminalState(
  job: k8s.V1Job,
): "completed" | "failed" | "active" {
  if (weeklyJobCondition(job, "Complete")) return "completed";
  if (weeklyJobCondition(job, "Failed")) return "failed";
  return "active";
}

async function deleteFailedWeeklyJob(
  batch: WeeklyJobClient,
  target: BackupTarget,
  jobName: string,
  runId: string,
  {
    timeoutMs = FAILED_JOB_DELETE_TIMEOUT_MS,
    pollIntervalMs = FAILED_JOB_DELETE_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = (delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    beforeCreate,
    beforeDelete = beforeCreate,
  }: FailedJobReplacementOptions = {},
): Promise<void> {
  const deadline = now() + Math.max(1, timeoutMs);
  let lastError: unknown;

  while (now() < deadline) {
    let existing: k8s.V1Job;
    try {
      existing = await batch.readNamespacedJob({
        name: jobName,
        namespace: target.namespace,
      });
    } catch (error) {
      if (statusCode(error) === 404) return;
      lastError = error;
      await sleep(Math.max(0, pollIntervalMs));
      continue;
    }

    if (!weeklyJobMatchesRun(existing, target.serverId, runId)) {
      throw new Error(
        `Refusing to replace weekly Job '${target.namespace}/${jobName}' with unexpected labels`,
      );
    }
    if (weeklyJobTerminalState(existing) !== "failed") {
      throw new Error(
        `Refusing to replace non-failed weekly Job '${target.namespace}/${jobName}'`,
      );
    }

    if (!existing.metadata?.deletionTimestamp) {
      const uid = existing.metadata?.uid;
      const resourceVersion = existing.metadata?.resourceVersion;
      if (!uid || !resourceVersion) {
        throw new Error(
          `Refusing to delete weekly Job '${target.namespace}/${jobName}' without Kubernetes identity preconditions`,
        );
      }
      if (!beforeDelete) {
        throw new Error(
          `Refusing to delete weekly Job '${target.namespace}/${jobName}' without re-fencing its Lease`,
        );
      }

      try {
        const confirmedUntil = await beforeDelete();
        // A stopped invocation can resume after another invocation replaced the
        // deterministic Job name. Re-fence next to DELETE, then bind the request
        // to the exact object observed above so it cannot remove a successor.
        if (confirmedUntil.getTime() <= now()) {
          throw new Error(
            `Confirmed weekly backup Lease for '${target.serverId}' expired before failed Job deletion`,
          );
        }
        await batch.deleteNamespacedJob({
          name: jobName,
          namespace: target.namespace,
          propagationPolicy: "Foreground",
          body: {
            preconditions: { uid, resourceVersion },
          },
        });
      } catch (error) {
        if (statusCode(error) === 404) return;
        if (!kubernetesCreateErrorIsAmbiguous(error)) throw error;
        lastError = error;
      }
    }

    await sleep(Math.max(0, pollIntervalMs));
  }

  throw new WeeklyJobReplacementUncertainError(target.namespace, jobName, lastError);
}

/**
 * Create the deterministic worker Job, reuse an accepted/current one after an
 * ambiguous POST, or replace a terminal Failed Job for a same-week retry. The
 * caller must hold its own unique per-invocation Lease for this whole call.
 */
export async function createOrReuseWeeklyJob(
  batch: WeeklyJobClient,
  target: BackupTarget,
  job: k8s.V1Job,
  runId: string,
  replacementOptions?: FailedJobReplacementOptions,
): Promise<WeeklyJobCreateOutcome> {
  const jobName = job.metadata?.name;
  if (!jobName) throw new Error(`Could not derive a Job name for server '${target.serverId}'`);
  const beforeCreate = replacementOptions?.beforeCreate;
  const requiredRemainingMs = replacementOptions?.requiredRemainingMs;
  const now = replacementOptions?.now ?? Date.now;

  const create = async (allowFailedReplacement: boolean): Promise<WeeklyJobCreateOutcome> => {
    // Failed-Job foreground deletion can consume the original termination
    // margin. Re-fence every POST so a recreated worker still receives its
    // entire active deadline under an authoritative Lease.
    if (beforeCreate) {
      if (
        requiredRemainingMs === undefined ||
        !Number.isFinite(requiredRemainingMs) ||
        requiredRemainingMs <= 0
      ) {
        throw new Error("Weekly Job creation requires a positive Lease deadline margin");
      }
      const confirmedUntil = await beforeCreate();
      // Keep an explicit authoritative-deadline check adjacent to the POST.
      // This catches a process pause after renewal returns but before control
      // reaches the Kubernetes create call.
      if (confirmedUntil.getTime() - now() < requiredRemainingMs) {
        throw new Error(
          `Confirmed weekly backup Lease for '${target.serverId}' no longer covers the worker deadline`,
        );
      }
    }
    try {
      await batch.createNamespacedJob({ namespace: target.namespace, body: job });
      return allowFailedReplacement ? "created" : "retried";
    } catch (createError) {
      let existing: k8s.V1Job;
      try {
        existing = await batch.readNamespacedJob({
          name: jobName,
          namespace: target.namespace,
        });
      } catch (readError) {
        if (statusCode(readError) === 404) {
          if (!kubernetesCreateErrorIsAmbiguous(createError)) throw createError;
          return "ambiguous";
        }
        // A read failure cannot prove that the POST was rejected. The caller
        // retains and monitors the Lease rather than opening another mutation.
        return "ambiguous";
      }

      if (!weeklyJobMatchesRun(existing, target.serverId, runId)) {
        throw new Error(
          `Weekly backup Job '${target.namespace}/${jobName}' exists with unexpected labels`,
        );
      }

      if (allowFailedReplacement && weeklyJobTerminalState(existing) === "failed") {
        await deleteFailedWeeklyJob(batch, target, jobName, runId, replacementOptions);
        return create(false);
      }

      return "reused";
    }
  };

  return create(true);
}

async function createBackupJob(
  clients: KubernetesClients,
  target: BackupTarget,
  config: BackupConfig,
  runId: string,
  invocationId: string,
): Promise<{ jobName: string; leaseHolder: string }> {
  await requireWorkerIdentity(
    clients.core,
    target.namespace,
    config.workerServiceAccount,
    config.workerRoleArn,
  );
  const leaseHolder = weeklyLeaseHolder(runId, invocationId);
  const leaseDurationSeconds =
    config.workerActiveDeadlineSeconds + WORKER_LEASE_HEADROOM_SECONDS;
  await acquireBackupLease(
    clients.coordination,
    target,
    leaseHolder,
    leaseDurationSeconds,
  );

  try {
    const leasedTarget = await resolveLeasedBackupTarget(clients.core, target);
    const workload = await serverWorkloadState(
      clients,
      leasedTarget.namespace,
      leasedTarget.serverId,
      leasedTarget.workloadLabel ?? BACKUP_SERVER_ID_LABEL,
    );
    if (workload.mode === "unsafe") {
      throw new Error(
        `Refusing an inconsistent weekly backup for '${leasedTarget.serverId}': ${workload.reason}`,
      );
    }
    leasedTarget.nodeName = workload.mode === "running" ? workload.nodeName : undefined;

    const requiredRemainingMs =
      (config.workerActiveDeadlineSeconds + WORKER_LEASE_TERMINATION_MARGIN_SECONDS) * 1_000;
    const renewWorkerLease = async (): Promise<Date> => {
      const leaseDeadline = await acquireBackupLease(
        clients.coordination,
        leasedTarget,
        leaseHolder,
        leaseDurationSeconds,
      );
      if (leaseDeadline.getTime() - Date.now() < requiredRemainingMs) {
        throw new Error(
          `Confirmed weekly backup Lease for '${leasedTarget.serverId}' does not cover the worker deadline`,
        );
      }
      return leaseDeadline;
    };
    const job = buildBackupJob(leasedTarget, config, runId, invocationId);
    const jobName = job.metadata?.name;
    if (!jobName) throw new Error(`Could not derive a Job name for server '${target.serverId}'`);
    const createOutcome = await createOrReuseWeeklyJob(
      clients.batch,
      leasedTarget,
      job,
      runId,
      {
        beforeCreate: renewWorkerLease,
        beforeDelete: renewWorkerLease,
        requiredRemainingMs,
      },
    );
    if (createOutcome === "ambiguous") {
      console.error(
        `Weekly Job '${target.namespace}/${jobName}' is not yet visible after an ambiguous create response; retaining the Lease for bounded monitoring`,
      );
      return { jobName, leaseHolder };
    }

    await acquireBackupLease(
      clients.coordination,
      leasedTarget,
      leaseHolder,
      leaseDurationSeconds,
    ).catch((renewError) => {
      console.error(
        `Could not extend the Lease after ${createOutcome} weekly Job '${target.namespace}/${jobName}'`,
        renewError,
      );
    });
    console.info(
      `${createOutcome === "created" ? "Created" : createOutcome === "retried" ? "Recreated" : "Reused"} weekly backup Job '${target.namespace}/${jobName}' for '${target.serverId}'`,
    );

    return { jobName, leaseHolder };
  } catch (error) {
    if (error instanceof WeeklyJobReplacementUncertainError) throw error;
    await releaseBackupLeaseWithRetry(clients.coordination, target, leaseHolder);
    throw error;
  }
}

async function waitForJob(
  clients: KubernetesClients,
  namespace: string,
  jobName: string,
  config: BackupConfig,
): Promise<void> {
  const deadline = Date.now() + (config.workerActiveDeadlineSeconds + 300) * 1_000;

  while (Date.now() < deadline) {
    let jobFailed = false;
    try {
      const job = await clients.batch.readNamespacedJob({ name: jobName, namespace });
      const conditions = job.status?.conditions ?? [];

      if (
        conditions.some(
          (condition) => condition.type === "Complete" && condition.status === "True",
        )
      ) {
        return;
      }
      if (
        conditions.some(
          (condition) => condition.type === "Failed" && condition.status === "True",
        )
      ) {
        jobFailed = true;
      }
    } catch {
      console.warn(
        `Could not read weekly backup Job '${namespace}/${jobName}'; retrying until its bounded deadline`,
      );
    }

    if (jobFailed) throw new Error(`Weekly backup Job '${namespace}/${jobName}' failed`);

    await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
  }

  throw new Error(`Timed out waiting for weekly backup Job '${namespace}/${jobName}'`);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function main(
  config: BackupConfig = loadConfig(),
  now: Date = new Date(),
  invocationId: string = resolveWeeklyInvocationId(),
): Promise<void> {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromCluster();
  const clients: KubernetesClients = {
    core: kubeConfig.makeApiClient(k8s.CoreV1Api),
    apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
    batch: kubeConfig.makeApiClient(k8s.BatchV1Api),
    coordination: kubeConfig.makeApiClient(k8s.CoordinationV1Api),
  };

  const pvcs = await listManagedPvcs(clients.core, config.labelSelector);
  if (pvcs.length === 0) {
    console.info("No PVCs matched the backup label selector; nothing to back up.");
    return;
  }

  const runId = weeklyRunId(now);
  const results = await mapWithConcurrency(pvcs, config.maxConcurrency, async (pvc) => {
    const target = targetFromPvc(pvc);
    const { jobName, leaseHolder } = await createBackupJob(
      clients,
      target,
      config,
      runId,
      invocationId,
    );
    try {
      await waitForJob(clients, target.namespace, jobName, config);
      console.info(`Weekly backup Job '${target.namespace}/${jobName}' completed and was verified`);
      return jobName;
    } finally {
      await releaseBackupLeaseWithRetry(clients.coordination, target, leaseHolder);
    }
  });

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure.reason);
    throw new Error(`${failures.length} of ${results.length} weekly backups failed`);
  }

  console.info(`Completed ${results.length} weekly backups for run '${runId}'`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Weekly backup orchestrator failed:", error);
    process.exit(1);
  });
}
