import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { provisioningBackupLeaseTestUtils } from "../src/modules/provisioning/service";

const names = {
  pvc: "pvc-server-realm-1",
  deployment: "deploy-server-realm-1",
  service: "svc-server-realm-1",
  configMap: "cm-server-realm-1",
  filesConfigMap: "cm-server-realm-1-files",
  networkPolicy: "netpol-server-realm-1",
};

const workloadLabels = {
  "app.kubernetes.io/name": "farlands-game-server",
  "app.kubernetes.io/managed-by": "farlands-backend",
  "farlands.dev/server-id": "realm-1",
  "farlands.dev/runtime": "paper",
};

describe("provisioning backup Lease", () => {
  test("does not bridge an expired ownership window or release its successor", async () => {
    let now = 1_000;
    let currentHolder: string | null = null;
    let currentDeadline = 0;
    let acquireCalls = 0;
    let mutationRan = false;
    const timer = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;

    const operation = provisioningBackupLeaseTestUtils.withProvisioningBackupLease(
      "fl-user",
      "realm-1",
      async (assertLeaseHeld) => {
        const provisioningDeadline = currentDeadline;
        now = provisioningDeadline;
        currentHolder = "weekly:2026-w35:successor";
        currentDeadline = now + 9_000_000;

        await assertLeaseHeld();
        mutationRan = true;
      },
      {
        now: () => now,
        acquire: async (_namespace, _serverId, holder, durationSeconds) => {
          acquireCalls += 1;
          currentHolder = holder;
          currentDeadline = now + (durationSeconds ?? 0) * 1_000;
          return new Date(currentDeadline);
        },
        release: async (_namespace, _serverId, holder) => {
          // Mirrors holder-safe release: a stale provisioner cannot delete the
          // successor's Lease.
          if (currentHolder === holder) currentHolder = null;
        },
        assertNoActiveBackup: async () => {},
        assertNoPendingCutover: async () => {},
        scheduleRenewal: () => timer,
        cancelRenewal: () => {},
      },
    );

    await expect(operation).rejects.toThrow("Backup Lease ownership window expired");
    expect(acquireCalls).toBe(2);
    expect(mutationRan).toBe(false);
    expect(currentHolder as string | null).toBe("weekly:2026-w35:successor");
  });

  test("fences a durable manual claim before a late provisioning mutation", async () => {
    const now = 1_000;
    let currentDeadline = 0;
    let durableBackupClaim = false;
    let mutationRan = false;
    let released = false;
    const timer = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;

    const operation = provisioningBackupLeaseTestUtils.withProvisioningBackupLease(
      "fl-user",
      "realm-1",
      async (assertLeaseHeld) => {
        durableBackupClaim = true;
        await assertLeaseHeld();
        mutationRan = true;
      },
      {
        now: () => now,
        acquire: async (_namespace, _serverId, _holder, durationSeconds) => {
          currentDeadline = now + (durationSeconds ?? 0) * 1_000;
          return new Date(currentDeadline);
        },
        release: async () => {
          released = true;
        },
        assertNoActiveBackup: async () => {
          if (durableBackupClaim) throw new Error("durable manual backup claim is active");
        },
        assertNoPendingCutover: async () => {},
        scheduleRenewal: () => timer,
        cancelRenewal: () => {},
      },
    );

    await expect(operation).rejects.toThrow("durable manual backup claim is active");
    expect(currentDeadline).toBeGreaterThan(now);
    expect(mutationRan).toBe(false);
    expect(released).toBe(true);
  });

  test("stops rollback before deleting through successor ownership", async () => {
    const deleted: string[] = [];
    let currentHolder = "server-provision";

    const clients = {
      core: {
        readNamespacedPersistentVolumeClaim: async () => ({
          metadata: {
            labels: workloadLabels,
            resourceVersion: "7",
          },
        }),
        deleteNamespacedPersistentVolumeClaim: async () => deleted.push("pvc"),
        deleteNamespacedConfigMap: async ({ name }: { name: string }) => deleted.push(name),
        deleteNamespacedService: async () => {
          deleted.push("service");
          currentHolder = "weekly-successor";
        },
      },
      apps: {
        deleteNamespacedDeployment: async () => deleted.push("deployment"),
      },
      networking: {
        deleteNamespacedNetworkPolicy: async () => deleted.push("networkPolicy"),
      },
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await provisioningBackupLeaseTestUtils.rollbackProvisionedResources(
        clients as never,
        names,
        ["pvc", "deployment", "service"],
        "fl-user",
        "realm-1",
        async () => {
          if (currentHolder !== "server-provision") {
            throw new Error("successor owns Lease");
          }
        },
      );
    } finally {
      console.error = originalConsoleError;
    }

    // Reverse-order rollback deletes Service first. Simulate a successor
    // takeover after that request; Deployment and PVC must remain untouched.
    expect(deleted).toEqual(["service"]);
  });

  test("publishes the weekly selector only after readiness", async () => {
    const pvc = provisioningBackupLeaseTestUtils.buildPvc(
      "fl-user",
      names,
      workloadLabels,
      10,
      "farlands-gp3",
    );
    expect(pvc.metadata?.labels?.["farlands.dev/backup-strategy"]).toBeUndefined();
    expect(pvc.metadata?.labels?.["farlands.dev/backup-server-id"]).toBeUndefined();
    pvc.metadata!.resourceVersion = "7";

    let published = structuredClone(pvc);
    let fenceCalls = 0;
    await provisioningBackupLeaseTestUtils.publishBackupDiscoveryLabels(
      {
        core: {
          readNamespacedPersistentVolumeClaim: async () => structuredClone(pvc),
          replaceNamespacedPersistentVolumeClaim: async ({ body }: { body: typeof pvc }) => {
            published = structuredClone(body);
            return body;
          },
        },
      } as never,
      names,
      "fl-user",
      "realm-1",
      async () => {
        fenceCalls += 1;
      },
    );
    expect(fenceCalls).toBe(1);
    expect(published.metadata?.labels?.["farlands.dev/backup-strategy"]).toBe("minecraft-rcon");
    expect(published.metadata?.labels?.["farlands.dev/backup-server-id"]).toBe("realm-1");

    let withdrawn = structuredClone(published);
    await provisioningBackupLeaseTestUtils.withdrawBackupDiscoveryLabels(
      {
        core: {
          readNamespacedPersistentVolumeClaim: async () => structuredClone(published),
          replaceNamespacedPersistentVolumeClaim: async ({ body }: { body: typeof pvc }) => {
            withdrawn = structuredClone(body);
            return body;
          },
        },
      } as never,
      names,
      "fl-user",
      "realm-1",
      async () => {
        fenceCalls += 1;
      },
    );
    expect(fenceCalls).toBe(2);
    expect(withdrawn.metadata?.labels?.["farlands.dev/backup-strategy"]).toBeUndefined();
    expect(withdrawn.metadata?.labels?.["farlands.dev/backup-server-id"]).toBeUndefined();

    const source = readFileSync(
      new URL("../src/modules/provisioning/service.ts", import.meta.url),
      "utf8",
    );
    const readiness = source.indexOf("await waitForDeploymentReplicasReady(");
    const publishCall = source.indexOf("await publishBackupDiscoveryLabels(", readiness);
    const persist = source.indexOf("await persistProvisioningState(", publishCall);
    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(publishCall).toBeGreaterThan(readiness);
    expect(persist).toBeGreaterThan(publishCall);
  });
});
