import { readFileSync } from "node:fs";
import type * as k8s from "@kubernetes/client-node";
import { serverK8s, serverRoutes } from "@repo/db";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { makeKubernetesClients as makeBatchClients } from "../../lib/k8s";
import {
  acquireBackupLease,
  assertBackupLeaseRemaining,
  releaseBackupLeaseWithRetry,
} from "../backup/lock";
import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "../provisioning/kubernetes";
import {
  RCON_PASSWORD_FILE,
  RCON_PORT,
  RCON_SECRET_NAME,
  tenantNamespace,
  WORLD_SYNC_NAMES,
  WORLD_SYNC_PORT,
  WORLD_SYNC_ROOT,
} from "../provisioning/tenancy";
import { requiredPinnedImage } from "../provisioning/utils";
import { assertNoActiveServerBackup } from "./guard";
import type { DeploymentRecord } from "./store";

const SERVER_PORT = 25565;
const CUTOVER_LEASE_SECONDS = 30 * 60;
const CUTOVER_LEASE_RENEW_INTERVAL_MS = 60_000;
const CUTOVER_LEASE_RENEW_ATTEMPTS = 3;
const CUTOVER_JOB_TERMINATION_MARGIN_SECONDS = 5 * 60;

export type CutoverLeaseFence = (requiredRemainingMs?: number) => Promise<number>;

export class CutoverJobStateUncertainError extends Error {
  readonly retryAt: Date;

  constructor(namespace: string, jobName: string, confirmedUntil: number, cause?: unknown) {
    super(`Cutover Job '${namespace}/${jobName}' has uncertain state; retaining the server Lease`, {
      cause,
    });
    this.name = "CutoverJobStateUncertainError";
    this.retryAt = new Date(confirmedUntil + 1_000);
  }
}

function resourceSuffix(deploymentId: string): string {
  return deploymentId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 20)
    .toLowerCase();
}

function cutoverNames(deploymentId: string) {
  const suffix = resourceSuffix(deploymentId);
  return {
    configMap: "cm-cutover-" + suffix,
    freezeJob: "job-freeze-" + suffix,
    recoveryJob: "job-save-on-" + suffix,
  };
}

export const FREEZE_DELTA_SCRIPT = readFileSync(
  new URL("./freeze_delta.py", import.meta.url),
  "utf8",
);

function checkpoint(row: DeploymentRecord, field: keyof DeploymentRecord): string {
  const value = row[field];
  if (typeof value !== "string" || !value) {
    throw new Error("Deployment " + row.id + " is missing checkpoint " + field);
  }
  return value;
}

export async function withCutoverBackupLease<T>(
  row: DeploymentRecord,
  operation: (assertLeaseHeld: CutoverLeaseFence) => Promise<T>,
): Promise<T> {
  const namespace = row.namespace ?? tenantNamespace(row.userId);
  const holder = `cutover:${row.id}:${row.workerId ?? "recovery"}`;
  const initialDeadline = await acquireBackupLease(
    namespace,
    row.serverId,
    holder,
    CUTOVER_LEASE_SECONDS,
  );

  let renewalPromise: Promise<void> | null = null;
  let lastRenewalError: unknown;
  let confirmedUntil = initialDeadline.getTime();

  const renewOnce = async (): Promise<void> => {
    const previousConfirmedUntil = confirmedUntil;
    if (Date.now() >= previousConfirmedUntil) {
      throw new Error("Cutover backup Lease ownership window expired before renewal");
    }
    const renewedDeadline = await acquireBackupLease(
      namespace,
      row.serverId,
      holder,
      CUTOVER_LEASE_SECONDS,
    );
    const confirmedAt = Date.now();
    if (confirmedAt >= previousConfirmedUntil) {
      // Never bridge an unobserved ownership gap. A restore may have acquired,
      // mutated, and released this Lease after the old window expired even if
      // the deterministic cutover holder can now be acquired again.
      throw new Error("Cutover backup Lease renewal completed after its ownership window expired");
    }
    const renewedUntil = renewedDeadline.getTime();
    if (confirmedAt >= renewedUntil) {
      throw new Error(
        "Cutover backup Lease renewal response arrived after the renewed Lease expired",
      );
    }
    confirmedUntil = renewedUntil;
    lastRenewalError = undefined;
  };
  const renewInBackground = () => {
    if (renewalPromise) return;
    renewalPromise = renewOnce()
      .catch((error) => {
        // A transient API failure must not permanently stop renewal. The next
        // interval retries, while every controller mutation explicitly fences.
        lastRenewalError = error;
      })
      .finally(() => {
        renewalPromise = null;
      });
  };
  const assertLeaseHeld: CutoverLeaseFence = async (requiredRemainingMs = 1) => {
    if (Date.now() >= confirmedUntil) {
      throw new Error("Cutover backup Lease ownership window expired");
    }
    if (renewalPromise) await renewalPromise;
    let error = lastRenewalError;
    for (let attempt = 1; attempt <= CUTOVER_LEASE_RENEW_ATTEMPTS; attempt += 1) {
      try {
        await renewOnce();
        await assertNoActiveServerBackup(row.serverId);
        assertBackupLeaseRemaining(confirmedUntil, requiredRemainingMs);
        return confirmedUntil;
      } catch (renewError) {
        error = renewError;
        lastRenewalError = renewError;
        if (attempt < CUTOVER_LEASE_RENEW_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        }
      }
    }
    const fenced = new Error("Cutover could not confirm its per-server backup Lease");
    (fenced as Error & { cause?: unknown }).cause = error;
    throw fenced;
  };
  const timer = setInterval(() => void renewInBackground(), CUTOVER_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();

  let retainLease = false;
  try {
    await assertLeaseHeld();
    const result = await operation(assertLeaseHeld);
    await assertLeaseHeld();
    return result;
  } catch (error) {
    retainLease = error instanceof CutoverJobStateUncertainError;
    throw error;
  } finally {
    clearInterval(timer);
    // A delayed renew must finish before delete; otherwise it could recreate
    // the holder after a successful release.
    await renewalPromise;
    if (retainLease) {
      console.error(
        `Cutover retained Lease '${namespace}/${holder}' until expiry because Job state is uncertain`,
      );
    } else {
      await releaseBackupLeaseWithRetry(namespace, row.serverId, holder);
    }
  }
}

export async function suspendLiveWeeklyBackup(row: DeploymentRecord): Promise<void> {
  const namespace = checkpoint(row, "namespace");
  const livePvcName = checkpoint(row, "livePvc");
  const { core } = makeKubernetesClients();
  const livePvc = await core.readNamespacedPersistentVolumeClaim({
    name: livePvcName,
    namespace,
  });
  if (!livePvc.metadata?.labels?.["farlands.dev/backup-strategy"]) return;
  delete livePvc.metadata.labels["farlands.dev/backup-strategy"];
  await core.replaceNamespacedPersistentVolumeClaim({
    name: livePvcName,
    namespace,
    body: livePvc,
  });
}

async function createScriptConfigMap(
  row: DeploymentRecord,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<void> {
  const namespace = checkpoint(row, "namespace");
  const name = cutoverNames(row.id).configMap;
  const { core } = makeKubernetesClients();
  const body: k8s.V1ConfigMap = {
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "farlands-backend",
        "farlands.dev/deployment-id": row.id,
        "farlands.dev/component": "cutover",
      },
    },
    data: { "freeze_delta.py": FREEZE_DELTA_SCRIPT },
  };
  try {
    await assertLeaseHeld();
    await core.createNamespacedConfigMap({ namespace, body });
  } catch (error) {
    if (getKubernetesStatusCode(error) !== 409) throw error;
    const existing = await core.readNamespacedConfigMap({ name, namespace });
    if (existing.data?.["freeze_delta.py"] !== FREEZE_DELTA_SCRIPT) {
      throw new Error("Cutover script ConfigMap conflicts with reviewed content");
    }
  }
}

function freezeJobBody(row: DeploymentRecord, saveOnOnly: boolean): k8s.V1Job {
  const namespace = checkpoint(row, "namespace");
  const liveService = checkpoint(row, "liveService");
  const names = cutoverNames(row.id);
  const image = requiredPinnedImage("FARLANDS_WORLD_SYNC_IMAGE");
  const name = saveOnOnly ? names.recoveryJob : names.freezeJob;
  const volumes: k8s.V1Volume[] = [
    { name: "cutover", configMap: { name: names.configMap, defaultMode: 365 } },
    { name: "rcon", secret: { secretName: RCON_SECRET_NAME } },
  ];
  const mounts: k8s.V1VolumeMount[] = [
    { name: "cutover", mountPath: "/cutover", readOnly: true },
    { name: "rcon", mountPath: "/run/secrets/rcon", readOnly: true },
  ];

  if (!saveOnOnly) {
    volumes.push(
      {
        name: "server-data",
        persistentVolumeClaim: { claimName: checkpoint(row, "candidatePvc") },
      },
      { name: "world-sync", configMap: { name: "cm-world-sync" } },
    );
    mounts.push(
      { name: "server-data", mountPath: "/data" },
      { name: "world-sync", mountPath: "/sync", readOnly: true },
    );
  }

  return {
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "farlands-backend",
        "farlands.dev/deployment-id": row.id,
        "farlands.dev/component": "cutover",
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: saveOnOnly ? 120 : 1_200,
      ttlSecondsAfterFinished: 3_600,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/managed-by": "farlands-backend",
            "farlands.dev/deployment-id": row.id,
            "farlands.dev/component": "cutover",
          },
        },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: { fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "freeze-delta",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["python3", "/cutover/freeze_delta.py"],
              env: [
                {
                  name: "RCON_HOST",
                  value: liveService + "." + namespace + ".svc.cluster.local",
                },
                { name: "RCON_PORT", value: String(RCON_PORT) },
                { name: "RCON_PASSWORD_FILE", value: RCON_PASSWORD_FILE },
                { name: "SAVE_ON_ONLY", value: String(saveOnOnly) },
                { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
                { name: "WORLD_ROOT", value: WORLD_SYNC_ROOT },
                { name: "WORLD_NAMES", value: WORLD_SYNC_NAMES },
                {
                  name: "SOURCE_SYNC_URL",
                  value:
                    "http://" +
                    liveService +
                    "." +
                    namespace +
                    ".svc.cluster.local:" +
                    WORLD_SYNC_PORT +
                    "/stream",
                },
                { name: "WORLD_SYNC_PHASE", value: "delta" },
                {
                  name: "WORLD_SYNC_SINCE_FILE",
                  value: saveOnOnly ? "/dev/null" : "/data/.farlands-presync-complete",
                },
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1", memory: "512Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
              },
              volumeMounts: mounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

function cutoverJobFingerprint(job: k8s.V1Job): string {
  const pod = job.spec?.template.spec;
  const container = pod?.containers.find((candidate) => candidate.name === "freeze-delta");
  const labels = (metadata: k8s.V1ObjectMeta | undefined) => ({
    managedBy: metadata?.labels?.["app.kubernetes.io/managed-by"],
    deploymentId: metadata?.labels?.["farlands.dev/deployment-id"],
    component: metadata?.labels?.["farlands.dev/component"],
  });
  const sorted = <T extends { name?: string }>(items: T[] | undefined) =>
    [...(items ?? [])].sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));

  return JSON.stringify({
    name: job.metadata?.name,
    namespace: job.metadata?.namespace,
    labels: labels(job.metadata),
    backoffLimit: job.spec?.backoffLimit,
    activeDeadlineSeconds: job.spec?.activeDeadlineSeconds,
    ttlSecondsAfterFinished: job.spec?.ttlSecondsAfterFinished,
    templateLabels: labels(job.spec?.template.metadata),
    pod: {
      automountServiceAccountToken: pod?.automountServiceAccountToken ?? true,
      serviceAccountName: pod?.serviceAccountName ?? "default",
      restartPolicy: pod?.restartPolicy,
      hostNetwork: pod?.hostNetwork ?? false,
      hostPID: pod?.hostPID ?? false,
      hostIPC: pod?.hostIPC ?? false,
      securityContext: pod?.securityContext,
      initContainerCount: pod?.initContainers?.length ?? 0,
      containerCount: pod?.containers.length ?? 0,
      container: container
        ? {
            name: container.name,
            image: container.image,
            imagePullPolicy: container.imagePullPolicy,
            command: container.command,
            args: container.args ?? [],
            env: sorted(container.env).map((entry) => ({
              name: entry.name,
              value: entry.value,
              valueFrom: entry.valueFrom,
            })),
            envFrom: container.envFrom ?? [],
            ports: container.ports ?? [],
            resources: container.resources,
            securityContext: container.securityContext,
            volumeMounts: sorted(container.volumeMounts).map((mount) => ({
              name: mount.name,
              mountPath: mount.mountPath,
              readOnly: mount.readOnly ?? false,
              subPath: mount.subPath,
            })),
          }
        : null,
      volumes: sorted(pod?.volumes).map((volume) => ({
        name: volume.name,
        configMap: volume.configMap?.name,
        secret: volume.secret?.secretName,
        persistentVolumeClaim: volume.persistentVolumeClaim?.claimName,
        hostPath: volume.hostPath
          ? { path: volume.hostPath.path, type: volume.hostPath.type }
          : undefined,
        emptyDir: volume.emptyDir,
        projected: volume.projected,
        csi: volume.csi,
      })),
    },
  });
}

export function cutoverJobMatchesExpected(existing: k8s.V1Job, expected: k8s.V1Job): boolean {
  return cutoverJobFingerprint(existing) === cutoverJobFingerprint(expected);
}

async function waitForJob(
  namespace: string,
  name: string,
  timeoutMs: number,
  confirmedUntil: number,
): Promise<void> {
  const { batch, core } = makeBatchClients();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let job: k8s.V1Job;
    try {
      job = await batch.readNamespacedJob({ name, namespace });
    } catch (error) {
      throw new CutoverJobStateUncertainError(namespace, name, confirmedUntil, error);
    }
    if ((job.status?.succeeded ?? 0) > 0) return;
    const failed = job.status?.conditions?.some(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );
    if (failed || (job.status?.failed ?? 0) > 0) {
      const pods = await core.listNamespacedPod({
        namespace,
        labelSelector: "job-name=" + name,
      });
      const podName = pods.items[0]?.metadata?.name;
      const logs = podName
        ? await core.readNamespacedPodLog({
            name: podName,
            namespace,
            container: "freeze-delta",
            tailLines: 200,
          })
        : "";
      throw new Error("Cutover job " + name + " failed" + (logs ? ": " + logs.slice(-2_000) : ""));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new CutoverJobStateUncertainError(
    namespace,
    name,
    confirmedUntil,
    new Error("Timed out waiting for the cutover Job to become terminal"),
  );
}

async function runJob(
  row: DeploymentRecord,
  saveOnOnly: boolean,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<void> {
  await createScriptConfigMap(row, assertLeaseHeld);
  const namespace = checkpoint(row, "namespace");
  const names = cutoverNames(row.id);
  const name = saveOnOnly ? names.recoveryJob : names.freezeJob;
  const activeDeadlineSeconds = saveOnOnly ? 120 : 1_200;
  const requiredRemainingMs =
    (activeDeadlineSeconds + CUTOVER_JOB_TERMINATION_MARGIN_SECONDS) * 1_000;
  const desiredJob = freezeJobBody(row, saveOnOnly);
  const { batch } = makeBatchClients();
  const confirmedUntil = await assertLeaseHeld(requiredRemainingMs);
  assertBackupLeaseRemaining(confirmedUntil, requiredRemainingMs);
  try {
    await batch.createNamespacedJob({
      namespace,
      body: desiredJob,
    });
  } catch (error) {
    let existing: k8s.V1Job;
    try {
      existing = await batch.readNamespacedJob({ name, namespace });
    } catch (readError) {
      const statusCode = getKubernetesStatusCode(error);
      if (
        statusCode === undefined ||
        statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 429 ||
        statusCode >= 500
      ) {
        throw new CutoverJobStateUncertainError(namespace, name, confirmedUntil, readError);
      }
      throw error;
    }
    if (!cutoverJobMatchesExpected(existing, desiredJob)) {
      throw new CutoverJobStateUncertainError(
        namespace,
        name,
        confirmedUntil,
        new Error("The deterministic Job name is occupied by a different workload"),
      );
    }
  }
  await waitForJob(namespace, name, activeDeadlineSeconds * 1_000, confirmedUntil);
}

export async function freezeAndSyncDelta(
  row: DeploymentRecord,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<void> {
  await runJob(row, false, assertLeaseHeld);
}

export async function ensureLiveSavesEnabled(
  row: DeploymentRecord,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<void> {
  await runJob(row, true, assertLeaseHeld);
}

type CutoverCleanupResource = {
  metadata?: k8s.V1ObjectMeta;
};

type CutoverCleanupIdentity = {
  uid: string;
  resourceVersion: string;
};

export async function deleteCutoverResourceWithFence(
  description: string,
  read: () => Promise<CutoverCleanupResource>,
  remove: (identity: CutoverCleanupIdentity) => Promise<unknown>,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<"deleted" | "absent"> {
  let existing: CutoverCleanupResource;
  try {
    existing = await read();
  } catch (error) {
    if (getKubernetesStatusCode(error) === 404) return "absent";
    throw error;
  }

  const uid = existing.metadata?.uid;
  const resourceVersion = existing.metadata?.resourceVersion;
  if (!uid || !resourceVersion) {
    throw new Error(`Refusing to delete ${description} without Kubernetes identity preconditions`);
  }

  await assertLeaseHeld();
  try {
    await remove({ uid, resourceVersion });
    return "deleted";
  } catch (error) {
    if (getKubernetesStatusCode(error) === 404) return "absent";
    throw error;
  }
}

export async function cleanupCutoverResources(
  row: DeploymentRecord,
  assertLeaseHeld: CutoverLeaseFence,
): Promise<void> {
  if (!row.namespace) return;
  const { batch } = makeBatchClients();
  const { core } = makeKubernetesClients();
  const names = cutoverNames(row.id);
  for (const name of [names.freezeJob, names.recoveryJob]) {
    await deleteCutoverResourceWithFence(
      `cutover Job '${row.namespace}/${name}'`,
      () => batch.readNamespacedJob({ name, namespace: row.namespace! }),
      (preconditions) =>
        batch.deleteNamespacedJob({
          name,
          namespace: row.namespace!,
          propagationPolicy: "Foreground",
          body: { preconditions },
        }),
      assertLeaseHeld,
    );
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pods = await core.listNamespacedPod({
      namespace: row.namespace,
      labelSelector: "farlands.dev/deployment-id=" + row.id + ",farlands.dev/component=cutover",
    });
    if (!pods.items.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = await core.listNamespacedPod({
    namespace: row.namespace,
    labelSelector: "farlands.dev/deployment-id=" + row.id + ",farlands.dev/component=cutover",
  });
  if (remaining.items.length) {
    throw new Error("Timed out waiting for cutover job pods to release the candidate volume");
  }
  await deleteCutoverResourceWithFence(
    `cutover ConfigMap '${row.namespace}/${names.configMap}'`,
    () => core.readNamespacedConfigMap({ name: names.configMap, namespace: row.namespace! }),
    (preconditions) =>
      core.deleteNamespacedConfigMap({
        name: names.configMap,
        namespace: row.namespace!,
        body: { preconditions },
      }),
    assertLeaseHeld,
  );
}

export function candidateProxyTarget(row: DeploymentRecord): string {
  const service = checkpoint(row, "candidateService");
  const namespace = checkpoint(row, "namespace");
  return service + "." + namespace + ".svc.cluster.local";
}

export async function switchServerRoute(serverId: string, proxyTarget: string): Promise<Date> {
  const switchedAt = new Date();
  const [updated] = await db
    .update(serverRoutes)
    .set({ proxyTarget, updatedAt: new Date() })
    .where(eq(serverRoutes.serverId, serverId))
    .returning({ id: serverRoutes.id });
  if (!updated) throw new Error("Server " + serverId + " has no route to switch");
  return switchedAt;
}

export async function restoreLiveDeployment(row: DeploymentRecord): Promise<void> {
  const namespace = checkpoint(row, "namespace");
  const liveDeployment = checkpoint(row, "liveDeployment");
  const clients = makeKubernetesClients();
  await clients.apps.patchNamespacedDeployment({
    name: liveDeployment,
    namespace,
    body: [{ op: "replace", path: "/spec/replicas", value: 1 }],
    fieldManager: "farlands-cutover",
  });
  await waitForDeploymentReplicasReady(clients.apps, liveDeployment, namespace, 1, {
    timeoutMs: 300_000,
    intervalMs: 1_000,
  });
}

function retainedResourceLabel(row: DeploymentRecord): string {
  return `retained-${resourceSuffix(row.id)}`.slice(0, 63);
}

async function demoteRetainedBackupResources(
  row: DeploymentRecord,
  clients: ReturnType<typeof makeKubernetesClients>,
): Promise<void> {
  const namespace = checkpoint(row, "namespace");
  const retainedLabel = retainedResourceLabel(row);
  const livePvcName = checkpoint(row, "livePvc");
  const liveDeploymentName = checkpoint(row, "liveDeployment");

  const livePvc = await clients.core.readNamespacedPersistentVolumeClaim({
    name: livePvcName,
    namespace,
  });
  livePvc.metadata ??= {};
  livePvc.metadata.labels = {
    ...(livePvc.metadata.labels ?? {}),
    "app.kubernetes.io/name": "farlands-retained-volume",
    "farlands.dev/server-id": retainedLabel,
  };
  delete livePvc.metadata.labels["farlands.dev/backup-strategy"];
  delete livePvc.metadata.labels["farlands.dev/backup-server-id"];
  await clients.core.replaceNamespacedPersistentVolumeClaim({
    name: livePvcName,
    namespace,
    body: livePvc,
  });

  // Only Deployment metadata is demoted. Its immutable selector and stopped
  // pod template stay intact for the retained rollback checkpoint.
  const liveDeployment = await clients.apps.readNamespacedDeployment({
    name: liveDeploymentName,
    namespace,
  });
  liveDeployment.metadata ??= {};
  liveDeployment.metadata.labels = {
    ...(liveDeployment.metadata.labels ?? {}),
    "app.kubernetes.io/name": "farlands-retained-server",
    "farlands.dev/server-id": retainedLabel,
  };
  delete liveDeployment.metadata.labels["farlands.dev/backup-strategy"];
  delete liveDeployment.metadata.labels["farlands.dev/backup-server-id"];
  await clients.apps.replaceNamespacedDeployment({
    name: liveDeploymentName,
    namespace,
    body: liveDeployment,
  });
}

async function promoteCandidateBackupVolume(
  row: DeploymentRecord,
  clients: ReturnType<typeof makeKubernetesClients>,
): Promise<void> {
  const namespace = checkpoint(row, "namespace");
  const candidatePvcName = checkpoint(row, "candidatePvc");
  const candidatePvc = await clients.core.readNamespacedPersistentVolumeClaim({
    name: candidatePvcName,
    namespace,
  });
  candidatePvc.metadata ??= {};
  candidatePvc.metadata.labels = {
    ...(candidatePvc.metadata.labels ?? {}),
    "app.kubernetes.io/name": "farlands-game-server",
    "farlands.dev/backup-server-id": row.serverId,
    "farlands.dev/backup-strategy": "minecraft-rcon",
  };
  await clients.core.replaceNamespacedPersistentVolumeClaim({
    name: candidatePvcName,
    namespace,
    body: candidatePvc,
  });
}

export async function retireLiveAndPromoteCandidate(row: DeploymentRecord): Promise<string> {
  const namespace = checkpoint(row, "namespace");
  const liveDeployment = checkpoint(row, "liveDeployment");
  const livePvc = checkpoint(row, "livePvc");
  const candidateDeployment = checkpoint(row, "candidatePod");
  const candidateService = checkpoint(row, "candidateService");
  const candidatePvc = checkpoint(row, "candidatePvc");
  const clients = makeKubernetesClients();

  await clients.apps.patchNamespacedDeployment({
    name: liveDeployment,
    namespace,
    body: [{ op: "replace", path: "/spec/replicas", value: 0 }],
    fieldManager: "farlands-cutover",
  });
  await waitForDeploymentReplicasReady(clients.apps, liveDeployment, namespace, 0, {
    timeoutMs: 180_000,
    intervalMs: 1_000,
  });

  // Stop discovering the retained checkpoint before the database pointer
  // moves. A crash here causes a safe missed run, never an archive of stale A.
  await demoteRetainedBackupResources(row, clients);

  const pods = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: "farlands.dev/deployment-id=" + row.id,
  });
  const candidatePod = pods.items.find((pod) => pod.metadata?.deletionTimestamp === undefined)
    ?.metadata?.name;

  const [updated] = await db
    .update(serverK8s)
    .set({
      deploymentName: candidateDeployment,
      serviceName: candidateService,
      pvcName: candidatePvc,
      podName: candidatePod ?? null,
    })
    .where(eq(serverK8s.serverId, row.serverId))
    .returning({ id: serverK8s.id });
  if (!updated) {
    throw new Error("Server " + row.serverId + " has no Kubernetes metadata to promote");
  }

  // The candidate already runs the consistency sidecar and dedicated backup
  // identity label. Publish its PVC to weekly discovery only after it is authoritative
  // in serverK8s, so manual and scheduled paths resolve the same workload.
  await promoteCandidateBackupVolume(row, clients);

  return "retained-pvc://" + namespace + "/" + livePvc;
}

export function routePort(): number {
  return SERVER_PORT;
}
