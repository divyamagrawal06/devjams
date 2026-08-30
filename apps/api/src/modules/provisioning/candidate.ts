import { gameServers, serverConfigs, serverK8s } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "./kubernetes";
import { ensureTenantNamespace, WORLD_SYNC_PORT } from "./tenancy";
import { calculateContainerMemory, MinecraftUtils } from "./utils";

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
    "app.kubernetes.io/name": "farlands-candidate",
    "app.kubernetes.io/managed-by": "farlands-backend",
    "farlands.dev/server-id": `${input.liveServerId}-cand`,
    "farlands.dev/live-server-id": input.liveServerId,
    "farlands.dev/deployment-id": input.deploymentId,
    "farlands.dev/role": "candidate",
    "farlands.dev/artifact": input.artifactDigest.slice("sha256:".length, 19),
  };
  const annotations = { "farlands.dev/rule-artifact-digest": input.artifactDigest };
  const artifactLoader = buildArtifactLoader(input);

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
            serviceAccountName:
              process.env.FARLANDS_ARTIFACT_SERVICE_ACCOUNT ?? "farlands-artifact-reader",
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
                image: "python:3.12-alpine",
                command: ["sh", "-c", "python3 /sync/receiver.py --once"],
                env: [
                  { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
                  { name: "WORLD_ROOT", value: "/data/world" },
                  {
                    name: "SOURCE_SYNC_URL",
                    value: `http://${k8sRow.serviceName}.${namespace}.svc.cluster.local:${WORLD_SYNC_PORT}/stream`,
                  },
                  { name: "WORLD_SYNC_TRANSFER_ID", value: input.deploymentId },
                  { name: "WORLD_SYNC_PHASE", value: "presync" },
                ],
                volumeMounts: [
                  { name: "server-data", mountPath: "/data" },
                  { name: "world-sync", mountPath: "/sync" },
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
  const image = process.env.FARLANDS_ARTIFACT_FETCH_IMAGE?.trim();
  if (!image) {
    throw new Error("FARLANDS_ARTIFACT_FETCH_IMAGE must pin the reviewed artifact loader image");
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("FARLANDS_ARTIFACT_FETCH_IMAGE must use an immutable sha256 image digest");
  }
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
  ];

  const failures: unknown[] = [];
  for (const del of deletions) {
    try {
      await del();
    } catch (error) {
      if (getKubernetesStatusCode(error) !== 404) failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Candidate cleanup did not delete every resource");
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
  const container = deploy.spec?.template?.spec?.containers?.[0];
  if (!container) throw new Error("candidate container missing");
  delete container.command;
  delete container.args;
  await clients.apps.replaceNamespacedDeployment({
    name: deploymentName,
    namespace,
    body: deploy,
  });
}
