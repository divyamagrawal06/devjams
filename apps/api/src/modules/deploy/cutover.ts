import { readFileSync } from "node:fs";
import type * as k8s from "@kubernetes/client-node";
import { serverK8s, serverRoutes } from "@repo/db";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { makeKubernetesClients as makeBatchClients } from "../../lib/k8s";
import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "../provisioning/kubernetes";
import {
  RCON_PASSWORD_FILE,
  RCON_PORT,
  RCON_SECRET_NAME,
  WORLD_SYNC_NAMES,
  WORLD_SYNC_PORT,
  WORLD_SYNC_ROOT,
} from "../provisioning/tenancy";
import { requiredPinnedImage } from "../provisioning/utils";
import type { DeploymentRecord } from "./store";

const SERVER_PORT = 25565;

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

async function createScriptConfigMap(row: DeploymentRecord): Promise<void> {
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

async function waitForJob(namespace: string, name: string, timeoutMs: number): Promise<void> {
  const { batch, core } = makeBatchClients();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({ name, namespace });
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
  throw new Error("Timed out waiting for cutover job " + name);
}

async function runJob(row: DeploymentRecord, saveOnOnly: boolean): Promise<void> {
  await createScriptConfigMap(row);
  const namespace = checkpoint(row, "namespace");
  const names = cutoverNames(row.id);
  const name = saveOnOnly ? names.recoveryJob : names.freezeJob;
  const { batch } = makeBatchClients();
  try {
    await batch.createNamespacedJob({
      namespace,
      body: freezeJobBody(row, saveOnOnly),
    });
  } catch (error) {
    if (getKubernetesStatusCode(error) !== 409) throw error;
  }
  await waitForJob(namespace, name, saveOnOnly ? 120_000 : 1_200_000);
}

export async function freezeAndSyncDelta(row: DeploymentRecord): Promise<void> {
  await runJob(row, false);
}

export async function ensureLiveSavesEnabled(row: DeploymentRecord): Promise<void> {
  await runJob(row, true);
}

export async function cleanupCutoverResources(row: DeploymentRecord): Promise<void> {
  if (!row.namespace) return;
  const { batch } = makeBatchClients();
  const { core } = makeKubernetesClients();
  const names = cutoverNames(row.id);
  for (const name of [names.freezeJob, names.recoveryJob]) {
    try {
      await batch.deleteNamespacedJob({
        name,
        namespace: row.namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (getKubernetesStatusCode(error) !== 404) throw error;
    }
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
  try {
    await core.deleteNamespacedConfigMap({
      name: names.configMap,
      namespace: row.namespace,
    });
  } catch (error) {
    if (getKubernetesStatusCode(error) !== 404) throw error;
  }
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

  return "retained-pvc://" + namespace + "/" + livePvc;
}

export function routePort(): number {
  return SERVER_PORT;
}
