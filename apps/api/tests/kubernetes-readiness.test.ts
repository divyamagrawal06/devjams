import { expect, test } from "bun:test";

import {
  type DeploymentStatusReader,
  resolveKubeconfigAwsProfile,
  waitForDeploymentReplicasReady,
  waitForDeploymentRolloutReady,
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

test("does not release a rollout wait for the previous ready generation", async () => {
  const responses = [
    {
      metadata: { generation: 8 },
      status: {
        observedGeneration: 7,
        replicas: 1,
        readyReplicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    },
    {
      metadata: { generation: 8 },
      status: {
        observedGeneration: 8,
        replicas: 1,
        readyReplicas: 0,
        updatedReplicas: 1,
        availableReplicas: 0,
        unavailableReplicas: 1,
      },
    },
    {
      metadata: { generation: 8 },
      status: {
        observedGeneration: 8,
        replicas: 1,
        readyReplicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
        unavailableReplicas: 0,
      },
    },
  ];
  const appsApi: DeploymentStatusReader & { calls: number } = {
    calls: 0,
    async readNamespacedDeployment() {
      const response = responses[Math.min(this.calls, responses.length - 1)];
      this.calls += 1;
      return response;
    },
  };

  await waitForDeploymentRolloutReady(appsApi, "deploy-server-test", "infra-team", 1, 8, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  expect(appsApi.calls).toBe(3);
});

test("preserves the selected kubeconfig AWS profile unless explicitly overridden", () => {
  // Use the resolver's structural boundary instead of constructing the SDK
  // class. Bun mocks are process-wide, so a different test file replacing the
  // Kubernetes module must not make this unit test depend on file order.
  const kubeConfig = {
    getUser(name: string) {
      return name === "maintainer"
        ? {
            name,
            exec: {
              apiVersion: "client.authentication.k8s.io/v1beta1",
              command: "aws",
              args: ["eks", "get-token"],
              env: [{ name: "AWS_PROFILE", value: "maintainer" }],
            },
          }
        : null;
    },
  };
  const context = { user: "maintainer" };

  expect(resolveKubeconfigAwsProfile(kubeConfig, context, "")).toBe("maintainer");
  expect(resolveKubeconfigAwsProfile(kubeConfig, context, "release-bot")).toBe("release-bot");
});
