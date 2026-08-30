import { describe, expect, test } from "bun:test";
import type * as k8s from "@kubernetes/client-node";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  backupOperationAttemptClaim,
  backupOperationAttemptMatches,
  backupOperationTerminalStatus,
  inferLegacyBackupOperation,
  legacyBackupOperationAdoptionClaim,
  runtimeLegacyBackupAttemptAdoptedAt,
  runtimeLegacyBackupAttemptId,
} from "../src/modules/backup/attempt";
import {
  acceptedBackupLeaseDeadline,
  acquireBackupLease,
  assertBackupLeaseFence,
  assertBackupLeaseRemaining,
  assertBackupLeaseRenewalFence,
  BACKUP_RECONCILIATION_LEASE_SECONDS,
  BackupOperationBusyError,
  backupLeaseExpired,
  backupLeaseHolder,
  backupLeaseName,
  backupOperationDispatchExpired,
  backupReconciliationLeaseHolder,
  kubernetesLeaseMutationErrorIsAmbiguous,
  retryBackupLeaseRelease,
  SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
} from "../src/modules/backup/lock";

describe("backup operation lease", () => {
  test("uses one stable server lock across every operation", () => {
    expect(backupLeaseName("SERVER_123")).toBe("backup-operation-server-123");
    expect(backupLeaseHolder("restore", "backup-id", "attempt-a")).toBe(
      "api:restore:backup-id:attempt-a",
    );
    expect(backupLeaseHolder("restore", "backup-id", "legacy-deadbeef")).toBe(
      "api:restore:backup-id",
    );
  });

  test("never lets a stale attempt release a retry holder", () => {
    const staleHolder = backupLeaseHolder("restore", "backup-id", "attempt-a");
    const retryHolder = backupLeaseHolder("restore", "backup-id", "attempt-b");

    expect(staleHolder).not.toBe(retryHolder);
    expect(staleHolder).toBe("api:restore:backup-id:attempt-a");
    expect(retryHolder).toBe("api:restore:backup-id:attempt-b");
  });

  test("a reconciliation takeover fences a paused dispatcher renewal", async () => {
    const dispatcherHolder = backupLeaseHolder("restore", "backup-id", "attempt-a");
    const reconciliationHolder = backupReconciliationLeaseHolder(
      "restore",
      "attempt-a",
      "reconcile-a",
    );
    let lease = {
      metadata: { name: "backup-operation-server-id", resourceVersion: "1", uid: "lease-uid" },
      spec: {
        holderIdentity: dispatcherHolder,
        renewTime: new Date(Date.now() - 10 * 60 * 1_000),
        leaseDurationSeconds: 60,
        leaseTransitions: 0,
      },
    } as k8s.V1Lease;
    let releaseDispatcher!: () => void;
    const dispatcherGate = new Promise<void>((resolve) => {
      releaseDispatcher = resolve;
    });
    let dispatcherReachedReplace!: () => void;
    const dispatcherAtReplace = new Promise<void>((resolve) => {
      dispatcherReachedReplace = resolve;
    });

    const coordination = {
      createNamespacedLease: async () => {
        throw { statusCode: 409 };
      },
      readNamespacedLease: async () => structuredClone(lease),
      replaceNamespacedLease: async ({ body }: { body: k8s.V1Lease }) => {
        if (body.spec?.holderIdentity === dispatcherHolder) {
          dispatcherReachedReplace();
          await dispatcherGate;
        }
        if (body.metadata?.resourceVersion !== lease.metadata?.resourceVersion) {
          throw { statusCode: 409 };
        }
        lease = {
          ...structuredClone(body),
          metadata: {
            ...structuredClone(body.metadata),
            resourceVersion: `${Number(lease.metadata?.resourceVersion ?? "0") + 1}`,
            uid: lease.metadata?.uid,
          },
        };
        return structuredClone(lease);
      },
      deleteNamespacedLease: async () => undefined,
    };

    const dispatcherRenewal = acquireBackupLease(
      "tenant",
      "server-id",
      dispatcherHolder,
      150 * 60,
      coordination as never,
    );
    await dispatcherAtReplace;

    await acquireBackupLease(
      "tenant",
      "server-id",
      reconciliationHolder,
      BACKUP_RECONCILIATION_LEASE_SECONDS,
      coordination as never,
    );
    releaseDispatcher();

    await expect(dispatcherRenewal).rejects.toBeInstanceOf(BackupOperationBusyError);
    expect(lease.spec?.holderIdentity).toBe(reconciliationHolder);
  });

  test("normalizes migration-era delete success and failure states", () => {
    expect(
      backupOperationTerminalStatus("delete", true, "in_progress", null, "archive.tar.gz"),
    ).toBe("deleted");
    expect(
      backupOperationTerminalStatus(
        "delete",
        false,
        "in_progress",
        new Date("2026-08-30T03:00:00Z"),
        "archive.tar.gz",
      ),
    ).toBe("completed");
    expect(backupOperationTerminalStatus("delete", false, "in_progress", null, "")).toBe("failed");
  });

  test("atomically adopts operations created by an old API after migration", () => {
    expect(inferLegacyBackupOperation("pending", null)).toBe("create");
    expect(inferLegacyBackupOperation("in_progress", "restore_started")).toBe("restore");
    expect(inferLegacyBackupOperation("in_progress", "restore_completed")).toBe("delete");
    expect(inferLegacyBackupOperation("in_progress", "restore_failed")).toBe("delete");
    expect(inferLegacyBackupOperation("in_progress", null)).toBe("delete");
    expect(inferLegacyBackupOperation("completed", "restore_started")).toBeNull();

    const dialect = new PgDialect();
    const adoptionClaim = dialect.sqlToQuery(legacyBackupOperationAdoptionClaim("in_progress"));
    expect(adoptionClaim.sql).toContain('"backups"."status" =');
    expect(adoptionClaim.sql.match(/ is null/g)).toHaveLength(3);
    expect(adoptionClaim.params).toEqual(["in_progress"]);

    const adoptedAt = new Date("2026-08-30T05:00:00.000Z");
    const attemptId = runtimeLegacyBackupAttemptId(
      adoptedAt,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(attemptId).toBe("legacy-runtime-1788066000000-00000000-0000-4000-8000-000000000000");
    expect(runtimeLegacyBackupAttemptAdoptedAt(attemptId)).toEqual(adoptedAt);
    expect(runtimeLegacyBackupAttemptAdoptedAt("legacy-migration-attempt")).toBeNull();
  });

  test("a stale reconciler CAS cannot finalize a newer retry", () => {
    const currentRetry = {
      activeOperation: "restore" as const,
      activeOperationAttemptId: "attempt-b",
    };

    expect(backupOperationAttemptMatches(currentRetry, "restore", "attempt-a")).toBe(false);
    expect(backupOperationAttemptMatches(currentRetry, "restore", "attempt-b")).toBe(true);

    const dialect = new PgDialect();
    const staleClaim = dialect.sqlToQuery(backupOperationAttemptClaim("restore", "attempt-a"));
    const retryClaim = dialect.sqlToQuery(backupOperationAttemptClaim("restore", "attempt-b"));

    expect(staleClaim.sql).toContain('"backups"."active_operation_attempt_id" =');
    expect(staleClaim.params).toEqual(["restore", "attempt-a"]);
    expect(retryClaim.params).toEqual(["restore", "attempt-b"]);
  });

  test("only permits takeover after the renew-time deadline", () => {
    const lease = {
      spec: {
        holderIdentity: "api:restore:backup-id",
        renewTime: new Date("2026-08-30T03:00:00Z"),
        leaseDurationSeconds: 120,
      },
    } as k8s.V1Lease;

    expect(backupLeaseExpired(lease, new Date("2026-08-30T03:01:59Z"))).toBe(false);
    expect(backupLeaseExpired(lease, new Date("2026-08-30T03:02:00Z"))).toBe(true);
  });

  test("fails closed across process pauses and renewal ownership gaps", () => {
    expect(() => assertBackupLeaseFence(10_000, 9_999)).not.toThrow();
    expect(() => assertBackupLeaseFence(10_000, 10_000)).toThrow(
      "Backup Lease ownership window expired",
    );
    expect(() => assertBackupLeaseRenewalFence(10_000, 20_000, 9_000, 9_500)).not.toThrow();
    expect(() => assertBackupLeaseRenewalFence(10_000, 20_000, 9_000, 10_000)).toThrow(
      "renewal completed after its prior ownership window expired",
    );
    expect(() => assertBackupLeaseRenewalFence(10_000, 20_000, 10_000, 10_001)).toThrow(
      "Backup Lease ownership window expired",
    );
  });

  test("requires the full worker deadline at the final Job creation fence", () => {
    expect(() => assertBackupLeaseRemaining(10_000, 5_000, 5_000)).not.toThrow();
    expect(() => assertBackupLeaseRemaining(10_000, 5_000, 5_001)).toThrow(
      "Backup Lease does not cover the worker Job deadline",
    );
    expect(() => assertBackupLeaseRemaining(10_000, 5_000, 10_000)).toThrow(
      "Backup Lease ownership window expired",
    );
  });

  test("recovers a durable operation claim when no Job appears within its grace period", () => {
    const createdAt = new Date("2026-08-30T03:00:00Z");
    const claimedAt = new Date("2026-08-30T04:00:00Z");

    expect(
      backupOperationDispatchExpired(claimedAt, createdAt, new Date("2026-08-30T04:04:59Z")),
    ).toBe(false);
    expect(
      backupOperationDispatchExpired(claimedAt, createdAt, new Date("2026-08-30T04:05:00Z")),
    ).toBe(true);
    expect(backupOperationDispatchExpired(null, createdAt, new Date("2026-08-30T03:05:00Z"))).toBe(
      true,
    );
  });

  test("bounds stale synchronous operation holders well below backup Job leases", () => {
    expect(SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS).toBe(15 * 60);
    expect(SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS).toBeLessThan(3 * 60 * 60);
  });

  test("requires readback after ambiguous Lease mutations", () => {
    expect(kubernetesLeaseMutationErrorIsAmbiguous(new Error("socket reset"))).toBe(true);
    expect(kubernetesLeaseMutationErrorIsAmbiguous({ code: "ECONNRESET" })).toBe(true);
    expect(kubernetesLeaseMutationErrorIsAmbiguous({ code: 408 })).toBe(true);
    expect(kubernetesLeaseMutationErrorIsAmbiguous({ statusCode: 503 })).toBe(true);
    expect(kubernetesLeaseMutationErrorIsAmbiguous({ statusCode: 422 })).toBe(false);
  });

  test("does not mistake an unchanged same-holder Lease for a successful renewal", () => {
    const desired = {
      metadata: { resourceVersion: "7" },
      spec: {
        holderIdentity: "cutover:dep-1:worker",
        renewTime: new Date("2026-08-30T03:10:00Z"),
        leaseDurationSeconds: 1_800,
      },
    } as k8s.V1Lease;
    const stale = {
      metadata: { resourceVersion: "7" },
      spec: {
        holderIdentity: "cutover:dep-1:worker",
        renewTime: new Date("2026-08-30T03:00:00Z"),
        leaseDurationSeconds: 1_800,
      },
    } as k8s.V1Lease;
    const renewed = {
      metadata: { resourceVersion: "8" },
      spec: {
        holderIdentity: "cutover:dep-1:worker",
        renewTime: new Date("2026-08-30T03:10:00Z"),
        leaseDurationSeconds: 1_800,
      },
    } as k8s.V1Lease;

    expect(acceptedBackupLeaseDeadline(stale, desired, "7")).toBeNull();
    expect(acceptedBackupLeaseDeadline(renewed, desired, "7")?.toISOString()).toBe(
      "2026-08-30T03:40:00.000Z",
    );
  });

  test("retries transient and conflicting releases with bounded backoff", async () => {
    const outcomes: Array<Error | boolean> = [new Error("API unavailable"), false, true];
    const delays: number[] = [];
    let attempts = 0;

    await retryBackupLeaseRelease(
      async () => {
        const outcome = outcomes[attempts++];
        if (outcome instanceof Error) throw outcome;
        return outcome ?? false;
      },
      {
        attempts: 3,
        initialBackoffMs: 25,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(attempts).toBe(3);
    expect(delays).toEqual([25, 50]);
  });

  test("treats an already-complete release as idempotent", async () => {
    let attempts = 0;

    await retryBackupLeaseRelease(async () => {
      attempts += 1;
      return true;
    });

    expect(attempts).toBe(1);
  });

  test("stops after the configured number of release attempts", async () => {
    let attempts = 0;

    await expect(
      retryBackupLeaseRelease(
        async () => {
          attempts += 1;
          return false;
        },
        {
          attempts: 3,
          initialBackoffMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("Backup Lease release conflicted after 3 attempts");

    expect(attempts).toBe(3);
  });
});
