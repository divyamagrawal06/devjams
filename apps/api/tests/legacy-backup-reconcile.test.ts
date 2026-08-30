import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as k8s from "@kubernetes/client-node";

import {
  buildBackupNetworkPolicy,
  buildDiscoverablePvc,
  buildReconciledConfigMap,
  buildReconciledDeployment,
  buildReconciledService,
} from "../src/modules/backup/reconcile";

beforeAll(() => {
  process.env.FARLANDS_WORLD_SYNC_IMAGE =
    "registry.example.invalid/world-sync@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
});

function legacyDeployment(): k8s.V1Deployment {
  return {
    metadata: {
      name: "legacy-deploy",
      namespace: "fl-user",
      resourceVersion: "17",
      generation: 4,
      labels: { legacy: "keep" },
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: { "legacy-selector": "realm" } },
      template: {
        metadata: { labels: { "legacy-selector": "realm" } },
        spec: {
          containers: [
            {
              name: "game-server",
              image: "minecraft@sha256:legacy",
              env: [{ name: "KEEP_ME", value: "yes" }],
              volumeMounts: [{ name: "legacy-world", mountPath: "/data" }],
            },
          ],
          volumes: [
            {
              name: "legacy-world",
              persistentVolumeClaim: { claimName: "legacy-pvc" },
            },
          ],
        },
      },
    },
  };
}

describe("legacy Minecraft backup reconciliation manifests", () => {
  test("adds the consistent-backup sidecar without replacing the world or replica intent", () => {
    const existing = legacyDeployment();
    const desired = buildReconciledDeployment(existing, {
      serverId: "realm-1",
      pvcName: "legacy-pvc",
    });

    expect(desired.spec?.replicas).toBe(0);
    expect(desired.spec?.selector).toEqual(existing.spec?.selector);
    expect(desired.spec?.strategy).toEqual({ type: "Recreate" });
    expect(desired.spec?.template.spec?.containers[0]).toMatchObject({
      name: "game-server",
      image: "minecraft@sha256:legacy",
      env: [{ name: "KEEP_ME", value: "yes" }],
      envFrom: [{ configMapRef: { name: "cm-server-realm-1" } }],
    });
    expect(desired.spec?.template.metadata?.labels).toMatchObject({
      "legacy-selector": "realm",
      "farlands.dev/backup-server-id": "realm-1",
    });
    expect(
      desired.spec?.template.spec?.containers.find(({ name }) => name === "world-sync"),
    ).toMatchObject({
      command: ["python3", "/sync/sender.py"],
      volumeMounts: [
        { name: "legacy-world", mountPath: "/data", readOnly: true },
        { name: "world-sync", mountPath: "/sync", readOnly: true },
        { name: "rcon", mountPath: "/run/secrets/rcon", readOnly: true },
      ],
    });
    expect(existing.spec?.template.spec?.containers).toHaveLength(1);

    const repeated = buildReconciledDeployment(desired, {
      serverId: "realm-1",
      pvcName: "legacy-pvc",
    });
    expect(repeated.spec).toEqual(desired.spec);
  });

  test("fails closed when the database PVC is not mounted by the deployment", () => {
    expect(() =>
      buildReconciledDeployment(legacyDeployment(), {
        serverId: "realm-1",
        pvcName: "different-pvc",
      }),
    ).toThrow("does not mount expected PVC");
  });

  test("repairs RCON config and adds only the world-sync Service port", () => {
    const config = buildReconciledConfigMap({
      metadata: { name: "cm-legacy", resourceVersion: "4" },
      data: { MOTD: "preserved", ENABLE_RCON: "false" },
    });
    expect(config.data).toMatchObject({
      MOTD: "preserved",
      ENABLE_RCON: "true",
      RCON_PASSWORD_FILE: "/run/secrets/rcon/password",
      RCON_PORT: "25575",
    });

    const service = buildReconciledService({
      metadata: { name: "svc-legacy", resourceVersion: "9" },
      spec: {
        clusterIP: "10.0.0.7",
        selector: { legacy: "realm" },
        ports: [{ name: "minecraft", port: 25565, nodePort: 30123 }],
      },
    });
    expect(service.spec?.clusterIP).toBe("10.0.0.7");
    expect(service.spec?.selector).toEqual({ legacy: "realm" });
    expect(service.spec?.ports).toContainEqual({
      name: "world-sync",
      port: 8080,
      targetPort: 8080,
      protocol: "TCP",
    });
    expect(service.spec?.ports?.find(({ name }) => name === "minecraft")?.nodePort).toBe(30123);
  });

  test("publishes weekly discovery metadata and a narrow backup ingress policy", () => {
    const pvc = buildDiscoverablePvc(
      {
        metadata: {
          name: "legacy-pvc",
          labels: { legacy: "keep" },
          annotations: { owner: "keep" },
        },
        spec: {},
      },
      { serverId: "realm-1", serviceName: "svc-custom" },
    );
    expect(pvc.metadata).toMatchObject({
      labels: {
        legacy: "keep",
        "app.kubernetes.io/name": "farlands-game-server",
        "farlands.dev/backup-strategy": "minecraft-rcon",
        "farlands.dev/backup-server-id": "realm-1",
      },
      annotations: { owner: "keep", "farlands.dev/backup-service": "svc-custom" },
    });

    const policy = buildBackupNetworkPolicy("fl-user", "realm-1");
    expect(policy.spec?.podSelector).toEqual({
      matchLabels: { "farlands.dev/backup-server-id": "realm-1" },
    });
    expect(policy.spec?.ingress?.[0]?.ports).toEqual([{ protocol: "TCP", port: 8080 }]);
  });

  test("operator command acquires the Lease and labels the PVC only after rollout", () => {
    const root = join(import.meta.dir, "..");
    const source = readFileSync(join(root, "src/modules/backup/reconcile.ts"), "utf8");
    const script = readFileSync(join(root, "scripts/reconcile-backup-workloads.ts"), "utf8");
    const execution = source.slice(source.indexOf("export async function reconcileLegacy"));
    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    const runbook = readFileSync(join(root, "backup-arch/README.md"), "utf8");

    expect(source).toContain("setInterval(renewInBackground");
    expect(source).toContain("await renewalPromise");
    expect(execution).toContain("ensureTenantNamespace(realm.userId, clients, assertLeaseHeld)");
    expect(execution).toContain("assertLegacyBackupReconciliationReady(realm)");
    expect(execution.indexOf("withReconciliationLease(realm")).toBeLessThan(
      execution.indexOf("assertLegacyBackupReconciliationReady(realm)"),
    );
    expect(execution.indexOf("waitForDeploymentRolloutReady(")).toBeLessThan(
      execution.indexOf("replaceNamespacedPersistentVolumeClaim"),
    );
    expect(
      execution.lastIndexOf(
        "await assertLeaseHeld()",
        execution.indexOf("replaceNamespacedPersistentVolumeClaim"),
      ),
    ).toBeGreaterThan(execution.indexOf("waitForDeploymentRolloutReady("));
    expect(
      execution.lastIndexOf(
        "await assertNoActiveBackupDatabaseClaim(realm.serverId)",
        execution.indexOf("replaceNamespacedPersistentVolumeClaim"),
      ),
    ).toBeGreaterThan(execution.indexOf("waitForDeploymentRolloutReady("));
    expect(script).toContain("await assertLegacyBackupReconciliationReady(realm)");
    expect(script).toContain("process.exit(1)");
    expect(packageJson).toContain('"reconcile:backups"');
    expect(runbook).toContain("bun run reconcile:backups");
    expect(runbook).toContain("Do not enable or unpause the CronJob");
  });
});
