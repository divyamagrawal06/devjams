import { expect, test } from "bun:test";
import { KubeConfig } from "@kubernetes/client-node";

import {
  type DeploymentStatusReader,
  resolveKubeconfigAwsProfile,
  waitForDeploymentReplicasReady,
} from "../src/modules/provisioning/kubernetes";

function makeStatusReader(
  statuses: Array<{ replicas?: number; readyReplicas?: number }>,
): DeploymentStatusReader & { calls: number } {
  return {
    calls: 0,
    async readNamespacedDeployment() {
      const status = statuses[Math.min(this.calls, statuses.length - 1)];
      this.calls += 1;
      return { status };
    },
  };
}

test("waits for a deployment's target number of ready replicas", async () => {
  const appsApi = makeStatusReader([
    { replicas: 1, readyReplicas: 0 },
    { replicas: 1, readyReplicas: 1 },
  ]);

  await waitForDeploymentReplicasReady(appsApi, "deploy-server-test", "infra-team", 1, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  expect(appsApi.calls).toBe(2);
});

test("waits for all replicas to disappear when scaling down", async () => {
  const appsApi = makeStatusReader([
    { replicas: 1, readyReplicas: 0 },
    { replicas: 0, readyReplicas: 0 },
  ]);

  await waitForDeploymentReplicasReady(appsApi, "deploy-server-test", "infra-team", 0, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  expect(appsApi.calls).toBe(2);
});

test("preserves the selected kubeconfig AWS profile unless explicitly overridden", () => {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "farlands", server: "https://example.test" }],
    users: [
      {
        name: "maintainer",
        exec: {
          apiVersion: "client.authentication.k8s.io/v1beta1",
          command: "aws",
          args: ["eks", "get-token"],
          env: [{ name: "AWS_PROFILE", value: "maintainer" }],
        },
      },
    ],
    contexts: [{ name: "farlands", cluster: "farlands", user: "maintainer" }],
    currentContext: "farlands",
  });
  const context = kubeConfig.getContexts().find((candidate) => candidate.name === "farlands");
  if (!context) throw new Error("test kubeconfig did not load its context");

  expect(resolveKubeconfigAwsProfile(kubeConfig, context, "")).toBe("maintainer");
  expect(resolveKubeconfigAwsProfile(kubeConfig, context, "release-bot")).toBe("release-bot");
});
