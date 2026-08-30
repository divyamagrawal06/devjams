import { describe, expect, test } from "bun:test";
import type * as k8s from "@kubernetes/client-node";
import {
  BACKUP_TENANT_WORKER_CLUSTER_ROLE,
  buildBackupOrchestratorRoleBinding,
  buildBackupWorkerServiceAccount,
  ensureBackupOrchestratorAccess,
  ensureBackupWorkerIdentity,
  ensureWorldSyncConfigMap,
  resolveBackupWorkerIdentityConfig,
} from "../src/modules/provisioning/tenancy";

const config = {
  roleArn: "arn:aws:iam::123456789012:role/farlands-backup-worker-irsa",
  serviceAccount: "backup-orchestrator",
};

describe("tenant backup identity", () => {
  test("requires an explicitly configured and valid IRSA role", () => {
    expect(() => resolveBackupWorkerIdentityConfig({})).toThrow(
      "cannot be created without weekly backup credentials",
    );
    expect(() =>
      resolveBackupWorkerIdentityConfig({
        FARLANDS_BACKUP_WORKER_ROLE_ARN: "not-an-arn",
      }),
    ).toThrow("valid IAM role ARN");
  });

  test("builds a non-token-mounted ServiceAccount with the managed role", () => {
    expect(buildBackupWorkerServiceAccount("fl-user", config)).toMatchObject({
      metadata: {
        name: "backup-orchestrator",
        namespace: "fl-user",
        annotations: { "eks.amazonaws.com/role-arn": config.roleArn },
      },
      automountServiceAccountToken: false,
    });
  });

  test("binds the scheduler's mutation rights only inside a tenant namespace", () => {
    expect(
      buildBackupOrchestratorRoleBinding("fl-user", {
        BACKUP_NAMESPACE: "infra-team",
        BACKUP_ORCHESTRATOR_SERVICE_ACCOUNT: "backup-orchestrator",
      }),
    ).toMatchObject({
      metadata: { namespace: "fl-user" },
      roleRef: { kind: "ClusterRole", name: BACKUP_TENANT_WORKER_CLUSTER_ROLE },
      subjects: [{ kind: "ServiceAccount", name: "backup-orchestrator", namespace: "infra-team" }],
    });
  });

  test("creates the identity in a new tenant namespace", async () => {
    let created: k8s.V1ServiceAccount | undefined;
    const core = {
      readNamespacedServiceAccount: async () => {
        throw { statusCode: 404 };
      },
      createNamespacedServiceAccount: async ({ body }: { body: k8s.V1ServiceAccount }) => {
        created = body;
        return body;
      },
    } as unknown as k8s.CoreV1Api;

    await ensureBackupWorkerIdentity(core, "fl-user", config);
    expect(created?.metadata?.annotations?.["eks.amazonaws.com/role-arn"]).toBe(config.roleArn);
  });

  test("fails closed when an existing identity is drifted", async () => {
    const core = {
      readNamespacedServiceAccount: async () => ({
        metadata: {
          name: config.serviceAccount,
          annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/other" },
        },
        automountServiceAccountToken: false,
      }),
    } as unknown as k8s.CoreV1Api;

    await expect(ensureBackupWorkerIdentity(core, "fl-user", config)).rejects.toThrow(
      "not the managed IRSA identity",
    );
  });

  test("refuses to place the shared backup role outside tenant namespaces", async () => {
    const core = {} as k8s.CoreV1Api;
    await expect(ensureBackupWorkerIdentity(core, "default", config)).rejects.toThrow(
      "outside an fl-* namespace",
    );
  });

  test("refuses to bind the scheduler outside tenant namespaces", async () => {
    const rbac = {} as k8s.RbacAuthorizationV1Api;
    await expect(ensureBackupOrchestratorAccess(rbac, "kube-system")).rejects.toThrow(
      "outside an fl-* namespace",
    );
  });

  test("updates an existing world-sync ConfigMap with its resource version and is repeatable", async () => {
    let current: k8s.V1ConfigMap = {
      metadata: {
        name: "cm-world-sync",
        namespace: "fl-user",
        resourceVersion: "41",
        labels: { preserved: "true" },
      },
      data: { "sender.py": "old", "receiver.py": "old", preserved: "value" },
    };
    let replaceCalls = 0;
    const core = {
      createNamespacedConfigMap: async () => {
        throw { statusCode: 409 };
      },
      readNamespacedConfigMap: async () => structuredClone(current),
      replaceNamespacedConfigMap: async ({ body }: { body: k8s.V1ConfigMap }) => {
        replaceCalls += 1;
        expect(body.metadata?.resourceVersion).toBe("41");
        expect(body.metadata?.labels).toEqual({ preserved: "true" });
        expect(body.data?.preserved).toBe("value");
        current = structuredClone(body);
        return body;
      },
    } as unknown as k8s.CoreV1Api;

    await ensureWorldSyncConfigMap(core, "fl-user");
    expect(replaceCalls).toBe(1);
    expect(current.data?.["sender.py"]).not.toBe("old");
    expect(current.data?.["receiver.py"]).not.toBe("old");

    await ensureWorldSyncConfigMap(core, "fl-user");
    expect(replaceCalls).toBe(1);
  });
});
