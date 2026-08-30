import type * as k8s from "@kubernetes/client-node";
import { gameServers, serverConfigs, serverK8s, serverRoutes } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "./kubernetes";
import {
  artifactServiceAccountName,
  ensureTenantNamespace,
  WORLD_SYNC_NAMES,
  WORLD_SYNC_PORT,
  WORLD_SYNC_ROOT,
} from "./tenancy";
import { calculateContainerMemory, MinecraftUtils, requiredPinnedImage } from "./utils";

const SERVER_PORT = 25565;

function candidateNames(liveServerId: string, deploymentId: string) {
  const short = deploymentId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 10)
    .toLowerCase();
  return {
    deployment: `deploy-cand-${liveServerId}-${short}`,
    service: `svc-cand-${liveServerId}-${short}`,
    pvc: `pvc-cand-${liveServerId}-${short}`,
    configMap: `cm-cand-${liveServerId}-${short}`,
    filesConfigMap: `cm-cand-${liveServerId}-${short}-files`,
    networkPolicy: `netpol-cand-${liveServerId}-${short}`,
  };
}

export type CandidateResources = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  pvcName: string;
  liveDeploymentName: string;
  liveServiceName: string;
  livePvcName: string;
  liveProxyTarget: string;
};

export async function provisionCandidate(input: {
  liveServerId: string;
  deploymentId: string;
  artifactUrl: string;
  artifactDigest: string;
  artifactRuntimeVersion: string;
}): Promise<CandidateResources> {
  const [server] = await db
    .select()
    .from(gameServers)
    .where(eq(gameServers.id, input.liveServerId))
    .limit(1);
  if (!server) throw new Error(`Server ${input.liveServerId} not found`);

  const k8sRow = await db.query.serverK8s.findFirst({
    where: eq(serverK8s.serverId, input.liveServerId),
  });
  if (!k8sRow) throw new Error(`Server ${input.liveServerId} has no k8s record`);

  const routeRow = await db.query.serverRoutes.findFirst({
    where: eq(serverRoutes.serverId, input.liveServerId),
  });
  if (!routeRow?.proxyTarget) {
    throw new Error(`Server ${input.liveServerId} has no live Velocity route target`);
  }

  const [config] = await db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.serverId, input.liveServerId))
    .limit(1);
  if (!config) throw new Error(`Server ${input.liveServerId} has no config`);

  assertCandidateArtifactCompatibility({
    artifactUrl: input.artifactUrl,
    artifactDigest: input.artifactDigest,
    artifactRuntimeVersion: input.artifactRuntimeVersion,
    serverRuntimeVersion: config.version,
  });

  const namespace = await ensureTenantNamespace(server.userId);
  const names = candidateNames(input.liveServerId, input.deploymentId);
  const clients = makeKubernetesClients();
  const image = await MinecraftUtils.getRuntimeImage(config.version ?? "latest");
  const mem = calculateContainerMemory(config.ramMb);
  const labels = {
    // Keep candidate Pods outside every live Service selector. The separate
    // backup-server-id label lets weekly discovery follow this workload only
    // after its PVC is marked active during promotion.
    "app.kubernetes.io/name": "farlands-candidate",
    "app.kubernetes.io/managed-by": "farlands-backend",
    "farlands.dev/server-id": `${input.liveServerId}-cand`,
    "farlands.dev/backup-server-id": input.liveServerId,
    "farlands.dev/live-server-id": input.liveServerId,
    "farlands.dev/deployment-id": input.deploymentId,
    "farlands.dev/role": "candidate",
    "farlands.dev/artifact": input.artifactDigest.slice("sha256:".length, 19),
  };
  const annotations = {
    "farlands.dev/rule-artifact-digest": input.artifactDigest,
    "farlands.dev/server-config-version": config.updatedAt.toISOString(),
    "farlands.dev/backup-service": names.service,
  };
  const artifactLoader = buildArtifactLoader(input);
  const worldSyncImage = requiredPinnedImage("FARLANDS_WORLD_SYNC_IMAGE");

  await clients.core.createNamespacedPersistentVolumeClaim({
    namespace,
    body: {
      metadata: { name: names.pvc, namespace, labels, annotations },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: config.storageClass,
        resources: { requests: { storage: `${config.storageGb}Gi` } },
      },
    },
  });

  await clients.core.createNamespacedConfigMap({
    namespace,
    body: {
      metadata: { name: names.configMap, namespace, labels, annotations },
      data: {
        EULA: "true",
        ENABLE_RCON: "true",
        RCON_PASSWORD_FILE: "/run/secrets/rcon/password",
        ONLINE_MODE: "false",
        SERVER_PORT: String(SERVER_PORT),
        TYPE: config.type.toUpperCase(),
        VERSION: config.version ?? "latest",
        REPLACE_ENV_DURING_SYNC: "true",
      },
    },
  });

  await clients.apps.createNamespacedDeployment({
    namespace,
    body: {
      metadata: { name: names.deployment, namespace, labels, annotations },
      spec: {
        replicas: 1,
        selector: { matchLabels: { "farlands.dev/deployment-id": input.deploymentId } },
        template: {
          metadata: { labels, annotations },
          spec: {
            automountServiceAccountToken: false,
            serviceAccountName: artifactServiceAccountName(),
            securityContext: { fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
            tolerations: [
              {
                key: "farlands.sh/nodepool",
                operator: "Equal",
                value: "infra-team-autoscale",
                effect: "NoSchedule",
              },
            ],
            initContainers: [
              artifactLoader,
              {
                name: "world-receiver",
                image: worldSyncImage,
                command: ["sh", "-c", "python3 /sync/receiver.py --once"],
                env: [
                  { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
                  { name: "WORLD_ROOT", value: WORLD_SYNC_ROOT },
                  { name: "WORLD_NAMES", value: WORLD_SYNC_NAMES },
                  {
                    name: "SOURCE_SYNC_URL",
                    value: `http://${k8sRow.serviceName}.${namespace}.svc.cluster.local:${WORLD_SYNC_PORT}/stream`,
                  },
                  { name: "WORLD_SYNC_TRANSFER_ID", value: input.deploymentId },
                  { name: "WORLD_SYNC_PHASE", value: "presync" },
                  { name: "WORLD_SYNC_MARKER", value: "/data/.farlands-presync-complete" },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  runAsGroup: 1000,
                },
                volumeMounts: [
                  { name: "server-data", mountPath: "/data" },
                  { name: "world-sync", mountPath: "/sync", readOnly: true },
                ],
              },
            ],
            containers: [
              {
                name: "game-server",
                image,
                imagePullPolicy: "IfNotPresent",
                // Paper is deliberately NOT started. World lands via the
                // receiver init; the controller starts Paper in verifying.
                command: ["sh", "-c", "echo 'candidate held; Paper not started'; sleep infinity"],
                envFrom: [{ configMapRef: { name: names.configMap } }],
                resources: {
                  requests: { cpu: config.cpuCores, memory: `${mem}Mi` },
                  limits: { cpu: config.cpuCores, memory: `${mem}Mi` },
                },
                volumeMounts: [
                  { name: "server-data", mountPath: "/data" },
                  {
                    name: "rcon",
                    mountPath: "/run/secrets/rcon",
                    readOnly: true,
                  },
                ],
              },
              buildCandidateWorldSyncSidecar(),
            ],
            volumes: [
              {
                name: "server-data",
                persistentVolumeClaim: { claimName: names.pvc },
              },
              { name: "world-sync", configMap: { name: "cm-world-sync" } },
              {
                name: "rcon",
                secret: { secretName: "rcon-password" },
              },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
  });

  await clients.core.createNamespacedService({
    namespace,
    body: {
      metadata: { name: names.service, namespace, labels, annotations },
      spec: {
        type: "ClusterIP",
        selector: { "farlands.dev/deployment-id": input.deploymentId },
        ports: [
          { name: "minecraft", port: SERVER_PORT, targetPort: SERVER_PORT },
          { name: "world-sync", port: WORLD_SYNC_PORT, targetPort: WORLD_SYNC_PORT },
        ],
      },
    },
  });

  await clients.networking.createNamespacedNetworkPolicy({
    namespace,
    body: buildCandidateNetworkPolicy(namespace, names.networkPolicy, labels, input.deploymentId),
  });

  await waitForDeploymentReplicasReady(clients.apps, names.deployment, namespace, 1, {
    timeoutMs: 240_000,
  });

  return {
    namespace,
    deploymentName: names.deployment,
    serviceName: names.service,
    pvcName: names.pvc,
    liveDeploymentName: k8sRow.deploymentName,
    liveServiceName: k8sRow.serviceName,
    livePvcName: k8sRow.pvcName,
    liveProxyTarget: routeRow.proxyTarget,
  };
}

export async function assertCandidateConfigCurrent(input: {
  serverId: string;
  namespace: string | null;
  candidateDeployment: string | null;
}): Promise<void> {
  if (!input.namespace || !input.candidateDeployment) {
    throw new Error("Candidate configuration checkpoints are incomplete");
  }
  const [current] = await db
    .select({ updatedAt: serverConfigs.updatedAt })
    .from(serverConfigs)
    .where(eq(serverConfigs.serverId, input.serverId))
    .limit(1);
  if (!current) throw new Error(`Server ${input.serverId} has no current config`);

  const { apps } = makeKubernetesClients();
  const candidate = await apps.readNamespacedDeployment({
    name: input.candidateDeployment,
    namespace: input.namespace,
  });
  const snapshottedAt = candidate.metadata?.annotations?.["farlands.dev/server-config-version"];
  if (snapshottedAt !== current.updatedAt.toISOString()) {
    throw new Error(
      "Server configuration changed after candidate provisioning; rebuild the candidate before cutover",
    );
  }
}

export function buildCandidateWorldSyncSidecar() {
  return {
    name: "world-sync",
    image: requiredPinnedImage("FARLANDS_WORLD_SYNC_IMAGE"),
    imagePullPolicy: "IfNotPresent" as const,
    command: ["python3", "/sync/sender.py"],
    ports: [{ name: "world-sync", containerPort: WORLD_SYNC_PORT, protocol: "TCP" }],
    env: [
      { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
      { name: "WORLD_ROOT", value: WORLD_SYNC_ROOT },
      { name: "WORLD_NAMES", value: WORLD_SYNC_NAMES },
      { name: "BACKUP_ROOT", value: "/data" },
      { name: "RCON_HOST", value: "127.0.0.1" },
      { name: "RCON_PORT", value: "25575" },
      { name: "RCON_PASSWORD_FILE", value: "/run/secrets/rcon/password" },
      { name: "PYTHONDONTWRITEBYTECODE", value: "1" },
    ],
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "200m", memory: "128Mi" },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
    },
    volumeMounts: [
      { name: "server-data", mountPath: "/data", readOnly: true },
      { name: "world-sync", mountPath: "/sync", readOnly: true },
      { name: "rcon", mountPath: "/run/secrets/rcon", readOnly: true },
    ],
  } satisfies k8s.V1Container;
}

function buildCandidateNetworkPolicy(
  namespace: string,
  name: string,
  labels: Record<string, string>,
  deploymentId: string,
): k8s.V1NetworkPolicy {
  const sharedFrom = {
    namespaceSelector: { matchLabels: { "farlands.dev/shared": "true" } },
  };
  return {
    metadata: { name, namespace, labels },
    spec: {
      podSelector: { matchLabels: { "farlands.dev/deployment-id": deploymentId } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "infra-team" },
              },
              podSelector: { matchLabels: { app: "velocity-proxy" } },
            },
            sharedFrom,
          ],
          ports: [{ protocol: "TCP", port: SERVER_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "dev-deployment" },
              },
              podSelector: { matchLabels: { app: "farlands-backend" } },
            },
            sharedFrom,
          ],
          ports: [{ protocol: "TCP", port: 25575 }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
        {
          from: [
            { podSelector: { matchLabels: { app: "server-backup-worker" } } },
            {
              podSelector: {
                matchLabels: { "app.kubernetes.io/name": "farlands-game-server" },
              },
            },
          ],
          ports: [{ protocol: "TCP", port: WORLD_SYNC_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
      ],
    },
  };
}

type CandidateArtifactInput = {
  artifactUrl: string;
  artifactDigest: string;
  artifactRuntimeVersion: string;
};

export function assertCandidateArtifactCompatibility(
  input: CandidateArtifactInput & {
    serverRuntimeVersion: string | null;
  },
): void {
  if (!input.artifactUrl.startsWith("s3://")) {
    throw new Error("Candidate rule artifacts must use immutable s3:// storage");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.artifactDigest)) {
    throw new Error("Candidate rule artifact digest is invalid");
  }
  if (!input.serverRuntimeVersion || input.serverRuntimeVersion === "latest") {
    throw new Error("Candidate Minecraft runtime must be pinned before rules can deploy");
  }
  if (input.artifactRuntimeVersion !== input.serverRuntimeVersion) {
    throw new Error(
      `Rule runtime ${input.artifactRuntimeVersion} is incompatible with server runtime ${input.serverRuntimeVersion}`,
    );
  }
}

export function buildArtifactLoader(input: CandidateArtifactInput) {
  const image = requiredPinnedImage("FARLANDS_ARTIFACT_FETCH_IMAGE");
  return {
    name: "rule-artifact",
    image,
    imagePullPolicy: "IfNotPresent" as const,
    command: [
      "/bin/sh",
      "-ceu",
      [
        "mkdir -p /data/plugins",
        'aws s3 cp "$ARTIFACT_URI" /data/plugins/farlands-rules.jar.partial --only-show-errors',
        'printf "%s  %s\\n" "$ARTIFACT_SHA256" "/data/plugins/farlands-rules.jar.partial" | sha256sum -c -',
        "mv /data/plugins/farlands-rules.jar.partial /data/plugins/farlands-rules.jar",
      ].join("\n"),
    ],
    env: [
      { name: "HOME", value: "/tmp" },
      { name: "ARTIFACT_URI", value: input.artifactUrl },
      {
        name: "ARTIFACT_SHA256",
        value: input.artifactDigest.slice("sha256:".length),
      },
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
    },
    volumeMounts: [
      { name: "server-data", mountPath: "/data" },
      { name: "tmp", mountPath: "/tmp" },
    ],
  };
}

export async function deleteCandidate(input: {
  namespace: string;
  deploymentName: string;
  liveServerId: string;
  deploymentId: string;
}): Promise<void> {
  const names = candidateNames(input.liveServerId, input.deploymentId);
  const clients = makeKubernetesClients();
  const ns = input.namespace;

  const deletions: Array<() => Promise<unknown>> = [
    () =>
      clients.apps.deleteNamespacedDeployment({
        name: names.deployment,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedService({
        name: names.service,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.configMap,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedPersistentVolumeClaim({
        name: names.pvc,
        namespace: ns,
      }),
    () =>
      clients.networking.deleteNamespacedNetworkPolicy({
        name: names.networkPolicy,
        namespace: ns,
      }),
  ];

  const failures: unknown[] = [];
  for (const del of deletions) {
    try {
      await del();
    } catch (error) {
      if (getKubernetesStatusCode(error) !== 404) failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Candidate cleanup left one or more resources behind");
  }
}

export async function startPaperOnCandidate(
  namespace: string,
  deploymentName: string,
): Promise<void> {
  const clients = makeKubernetesClients();
  const deploy = await clients.apps.readNamespacedDeployment({
    name: deploymentName,
    namespace,
  });
  const spec = deploy.spec;
  if (!spec) throw new Error("candidate deployment spec missing");
  const container = spec.template.spec?.containers?.[0];
  if (!container) throw new Error("candidate container missing");
  delete container.command;
  delete container.args;
  container.startupProbe = {
    tcpSocket: { port: SERVER_PORT },
    failureThreshold: 60,
    periodSeconds: 2,
  };
  container.readinessProbe = {
    tcpSocket: { port: SERVER_PORT },
    failureThreshold: 3,
    periodSeconds: 2,
  };
  container.livenessProbe = {
    tcpSocket: { port: SERVER_PORT },
    failureThreshold: 6,
    periodSeconds: 10,
  };
  spec.replicas = 1;
  spec.template.metadata ??= {};
  spec.template.metadata.annotations = {
    ...(spec.template.metadata.annotations ?? {}),
    "farlands.dev/candidate-started-at": new Date().toISOString(),
  };
  await clients.apps.replaceNamespacedDeployment({
    name: deploymentName,
    namespace,
    body: deploy,
  });
}

export async function stopCandidateForDelta(
  namespace: string,
  deploymentName: string,
): Promise<void> {
  const clients = makeKubernetesClients();
  await clients.apps.patchNamespacedDeployment({
    name: deploymentName,
    namespace,
    body: [{ op: "replace", path: "/spec/replicas", value: 0 }],
    fieldManager: "farlands-cutover",
  });
  await waitForDeploymentReplicasReady(clients.apps, deploymentName, namespace, 0, {
    timeoutMs: 120_000,
    intervalMs: 1_000,
  });
}

export type CandidateHealthEvidence = {
  podName: string;
  artifactDigest: string;
  pluginEnabled: boolean;
  serverReady: boolean;
};

export async function verifyCandidateHealth(input: {
  namespace: string;
  deploymentName: string;
  deploymentId: string;
  artifactDigest: string;
  timeoutMs?: number;
}): Promise<CandidateHealthEvidence> {
  const clients = makeKubernetesClients();
  await waitForDeploymentReplicasReady(clients.apps, input.deploymentName, input.namespace, 1, {
    timeoutMs: input.timeoutMs ?? 300_000,
    intervalMs: 1_000,
  });

  const deployment = await clients.apps.readNamespacedDeployment({
    name: input.deploymentName,
    namespace: input.namespace,
  });
  const observedDigest = deployment.metadata?.annotations?.["farlands.dev/rule-artifact-digest"];
  if (observedDigest !== input.artifactDigest) {
    throw new Error("Candidate deployment annotation does not match the reviewed artifact digest");
  }

  const deadline = Date.now() + (input.timeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    const pods = await clients.core.listNamespacedPod({
      namespace: input.namespace,
      labelSelector: `farlands.dev/deployment-id=${input.deploymentId}`,
    });
    const pod = pods.items.find(
      (candidate) =>
        candidate.metadata?.deletionTimestamp === undefined &&
        candidate.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
    );
    if (pod?.metadata?.name) {
      const artifactInit = pod.status?.initContainerStatuses?.find(
        (status) => status.name === "rule-artifact",
      );
      if (artifactInit?.state?.terminated?.exitCode !== 0) {
        throw new Error("Candidate artifact loader did not complete successfully");
      }
      const gameStatus = pod.status?.containerStatuses?.find(
        (status) => status.name === "game-server",
      );
      if ((gameStatus?.restartCount ?? 0) > 0) {
        throw new Error("Candidate game server restarted during verification");
      }
      const logs = await clients.core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: input.namespace,
        container: "game-server",
        tailLines: 1_000,
        timestamps: true,
      });
      if (
        /\b(?:SEVERE|FATAL)\b|Exception in server tick loop|Could not load ['"]?FarlandsPlugin/i.test(
          logs,
        )
      ) {
        throw new Error("Candidate logs contain a fatal startup or plugin-load error");
      }
      const pluginEnabled = logs.includes("Farlands Plugin Enabled");
      const serverReady = /Done \([^)]+\)! For help/.test(logs);
      if (pluginEnabled && serverReady) {
        return {
          podName: pod.metadata.name,
          artifactDigest: observedDigest,
          pluginEnabled,
          serverReady,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for candidate health evidence");
}
