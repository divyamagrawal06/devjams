import { createHash, randomBytes } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { KubeConfig } from "@kubernetes/client-node";

import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "../src/modules/provisioning/kubernetes";

const PREFIX = "fl-cutover-e2e-";
const RUN_LABEL = "farlands.dev/live-cutover-test";
const ARTIFACT = "reviewed-rule-artifact-v7\n";
const ARTIFACT_DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live adapter test`);
  return value;
}

function phase(name: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ phase: name, ...detail })}\n`);
}

function deployment(input: {
  namespace: string;
  runId: string;
  name: string;
  slot: "a" | "b" | "lobby";
  replicas: number;
  image: string;
}): k8s.V1Deployment {
  const realm = input.slot === "lobby" ? "lobby" : "realm";
  const labels = {
    [RUN_LABEL]: input.runId,
    "farlands.dev/component": realm,
    "farlands.dev/slot": input.slot,
  };
  const volumes: k8s.V1Volume[] = [
    {
      name: "page",
      configMap: { name: `page-${input.slot}` },
    },
  ];
  const volumeMounts: k8s.V1VolumeMount[] = [
    {
      name: "page",
      mountPath: "/usr/share/nginx/html/index.html",
      subPath: "index.html",
      readOnly: true,
    },
  ];
  const initContainers: k8s.V1Container[] = [];

  if (input.slot === "b") {
    volumes.push({ name: "reviewed-rule", configMap: { name: "reviewed-rule" } });
    volumeMounts.push({
      name: "reviewed-rule",
      mountPath: "/reviewed/rule.txt",
      subPath: "rule.txt",
      readOnly: true,
    });
    initContainers.push({
      name: "verify-reviewed-rule",
      image: input.image,
      imagePullPolicy: "IfNotPresent",
      command: [
        "/bin/sh",
        "-ceu",
        'printf "%s  %s\\n" "$EXPECTED_SHA256" /reviewed/rule.txt | sha256sum -c -',
      ],
      env: [{ name: "EXPECTED_SHA256", value: ARTIFACT_DIGEST }],
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        readOnlyRootFilesystem: true,
      },
      volumeMounts: [volumeMounts.at(-1)!],
    });
  }

  return {
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels,
      annotations:
        input.slot === "b"
          ? { "farlands.dev/rule-artifact-digest": `sha256:${ARTIFACT_DIGEST}` }
          : undefined,
    },
    spec: {
      replicas: input.replicas,
      selector: { matchLabels: labels },
      strategy: { type: "Recreate" },
      template: {
        metadata: {
          labels,
          annotations:
            input.slot === "b"
              ? { "farlands.dev/rule-artifact-digest": `sha256:${ARTIFACT_DIGEST}` }
              : undefined,
        },
        spec: {
          automountServiceAccountToken: false,
          initContainers,
          containers: [
            {
              name: "server",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              ports: [{ name: "http", containerPort: 80 }],
              readinessProbe: {
                httpGet: { path: "/", port: 80 },
                periodSeconds: 1,
                failureThreshold: 10,
              },
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "100m", memory: "64Mi" },
              },
              volumeMounts,
            },
          ],
          tolerations: [
            {
              key: "farlands.sh/nodepool",
              operator: "Equal",
              value: "infra-team-autoscale",
              effect: "NoSchedule",
            },
          ],
          volumes,
        },
      },
    },
  };
}

async function waitForServiceSlot(
  namespace: string,
  runId: string,
  serviceName: string,
  expectedSlot: string,
  timeoutMs = 90_000,
): Promise<string[]> {
  const { core } = makeKubernetesClients();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [endpoints, pods] = await Promise.all([
      core.readNamespacedEndpoints({ name: serviceName, namespace }),
      core.listNamespacedPod({ namespace, labelSelector: `${RUN_LABEL}=${runId}` }),
    ]);
    const slots = new Map(
      pods.items.map((pod) => [
        pod.metadata?.name ?? "",
        pod.metadata?.labels?.["farlands.dev/slot"],
      ]),
    );
    const endpointPods =
      endpoints.subsets?.flatMap(
        (subset) => subset.addresses?.map((address) => address.targetRef?.name ?? "") ?? [],
      ) ?? [];
    if (endpointPods.length && endpointPods.every((pod) => slots.get(pod) === expectedSlot)) {
      return endpointPods;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${serviceName} to select slot ${expectedSlot}`);
}

async function scale(namespace: string, name: string, replicas: number): Promise<void> {
  const { apps } = makeKubernetesClients();
  await apps.patchNamespacedDeployment({
    name,
    namespace,
    body: [{ op: "replace", path: "/spec/replicas", value: replicas }],
    fieldManager: "farlands-live-cutover-test",
  });
  await waitForDeploymentReplicasReady(apps, name, namespace, replicas, {
    timeoutMs: 180_000,
    intervalMs: 500,
  });
}

async function route(namespace: string, slot: "a" | "b"): Promise<void> {
  const { core } = makeKubernetesClients();
  await core.patchNamespacedService({
    name: "realm",
    namespace,
    body: [{ op: "replace", path: "/spec/selector/farlands.dev~1slot", value: slot }],
    fieldManager: "farlands-live-cutover-test",
  });
}

async function verifyCandidateEvidence(namespace: string, runId: string): Promise<void> {
  const { apps, core } = makeKubernetesClients();
  const candidate = await apps.readNamespacedDeployment({ name: "candidate-b", namespace });
  if (
    candidate.metadata?.annotations?.["farlands.dev/rule-artifact-digest"] !==
    `sha256:${ARTIFACT_DIGEST}`
  ) {
    throw new Error("Candidate annotation did not retain the reviewed digest");
  }
  const pods = await core.listNamespacedPod({
    namespace,
    labelSelector: `${RUN_LABEL}=${runId},farlands.dev/slot=b`,
  });
  const pod = pods.items.find((item) => item.metadata?.deletionTimestamp === undefined);
  const verifier = pod?.status?.initContainerStatuses?.find(
    (container) => container.name === "verify-reviewed-rule",
  );
  if (verifier?.state?.terminated?.exitCode !== 0) {
    throw new Error("Candidate did not load the exact reviewed artifact");
  }
}

async function deleteTestNamespace(namespace: string, runId: string): Promise<void> {
  if (!new RegExp(`^${PREFIX}[a-f0-9]{10}$`).test(namespace)) {
    throw new Error("Refusing to delete a namespace outside the live-test prefix");
  }
  const { core } = makeKubernetesClients();
  const existing = await core.readNamespace({ name: namespace });
  if (existing.metadata?.labels?.[RUN_LABEL] !== runId) {
    throw new Error("Refusing to delete a namespace without the exact live-test label");
  }
  await core.deleteNamespace({ name: namespace, propagationPolicy: "Foreground" });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await core.readNamespace({ name: namespace });
    } catch (error) {
      if (getKubernetesStatusCode(error) === 404) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for test namespace ${namespace} to delete`);
}

async function main(): Promise<void> {
  if (process.env.FARLANDS_LIVE_CUTOVER_TEST !== "true") {
    throw new Error(
      "Set FARLANDS_LIVE_CUTOVER_TEST=true to authorize disposable cluster resources",
    );
  }
  const expectedContext = required("FARLANDS_LIVE_TEST_CONTEXT");
  const image = required("FARLANDS_LIVE_TEST_IMAGE");
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("FARLANDS_LIVE_TEST_IMAGE must use an immutable sha256 digest");
  }
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  if (kubeConfig.getCurrentContext() !== expectedContext) {
    throw new Error("Current Kubernetes context does not match FARLANDS_LIVE_TEST_CONTEXT");
  }

  const runId = randomBytes(5).toString("hex");
  const namespace = `${PREFIX}${runId}`;
  const { apps, core } = makeKubernetesClients();
  let created = false;
  try {
    await core.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: {
            [RUN_LABEL]: runId,
            "pod-security.kubernetes.io/enforce": "baseline",
          },
          annotations: {
            "farlands.dev/purpose": "disposable-real-cutover-adapter-verification",
            "farlands.dev/expires-at": new Date(Date.now() + 30 * 60_000).toISOString(),
          },
        },
      },
    });
    created = true;
    phase("namespace-created", { namespace, context: expectedContext });

    for (const [name, content] of [
      ["page-a", "server-a\n"],
      ["page-b", "candidate-b\n"],
      ["page-lobby", "lobby\n"],
      ["reviewed-rule", ARTIFACT],
    ] as const) {
      await core.createNamespacedConfigMap({
        namespace,
        body: {
          metadata: { name, namespace, labels: { [RUN_LABEL]: runId } },
          data: { [name === "reviewed-rule" ? "rule.txt" : "index.html"]: content },
        },
      });
    }

    await apps.createNamespacedDeployment({
      namespace,
      body: deployment({ namespace, runId, name: "server-a", slot: "a", replicas: 1, image }),
    });
    await apps.createNamespacedDeployment({
      namespace,
      body: deployment({
        namespace,
        runId,
        name: "candidate-b",
        slot: "b",
        replicas: 0,
        image,
      }),
    });
    await apps.createNamespacedDeployment({
      namespace,
      body: deployment({
        namespace,
        runId,
        name: "lobby",
        slot: "lobby",
        replicas: 1,
        image,
      }),
    });
    await core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: "realm", namespace, labels: { [RUN_LABEL]: runId } },
        spec: {
          selector: {
            [RUN_LABEL]: runId,
            "farlands.dev/component": "realm",
            "farlands.dev/slot": "a",
          },
          ports: [{ name: "http", port: 80, targetPort: 80 }],
        },
      },
    });
    await core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: "lobby", namespace, labels: { [RUN_LABEL]: runId } },
        spec: {
          selector: { [RUN_LABEL]: runId, "farlands.dev/component": "lobby" },
          ports: [{ name: "http", port: 80, targetPort: 80 }],
        },
      },
    });

    await Promise.all([
      waitForDeploymentReplicasReady(apps, "server-a", namespace, 1, { intervalMs: 500 }),
      waitForDeploymentReplicasReady(apps, "lobby", namespace, 1, { intervalMs: 500 }),
    ]);
    await waitForServiceSlot(namespace, runId, "realm", "a");
    await waitForServiceSlot(namespace, runId, "lobby", "lobby");
    phase("source-and-lobby-ready");

    await scale(namespace, "candidate-b", 1);
    await verifyCandidateEvidence(namespace, runId);
    phase("candidate-verified", { artifactDigest: `sha256:${ARTIFACT_DIGEST}` });

    await route(namespace, "b");
    const candidateEndpoints = await waitForServiceSlot(namespace, runId, "realm", "b");
    phase("cutover-observed", { candidateEndpoints });
    await scale(namespace, "server-a", 0);
    phase("source-drained");

    await scale(namespace, "server-a", 1);
    await route(namespace, "a");
    const rollbackEndpoints = await waitForServiceSlot(namespace, runId, "realm", "a");
    await scale(namespace, "candidate-b", 0);
    phase("rollback-observed", { rollbackEndpoints });
  } finally {
    if (created) {
      await deleteTestNamespace(namespace, runId);
      phase("namespace-deleted", { namespace });
    }
  }
}

await main();
