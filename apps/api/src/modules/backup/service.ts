import { backupLogs, backups, gameServers, serverK8s, userQuotas } from "@repo/db";
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import { status } from "elysia";
import { db } from "../../db";
import { reconcileTimeBoundEntitlementInTransaction } from "../billing/reconciliation";
import { ServerCutoverInProgressError } from "../deploy/guard";
import { ServerService } from "../servers/service";
import {
  type BackupOperation,
  backupOperationAttemptClaim,
  backupOperationAttemptMatches,
  backupOperationTerminalStatus,
  inferLegacyBackupOperation,
  legacyBackupOperationAdoptionClaim,
  runtimeLegacyBackupAttemptAdoptedAt,
  runtimeLegacyBackupAttemptId,
} from "./attempt";
import {
  backupScheduleHealth,
  nextWeeklyBackupRun,
  resolveBackupScheduleConfig,
  resolveBackupStorageConfig,
} from "./config";
import {
  BackupJobNotStartedError,
  dispatchBackupDeleteJob,
  dispatchBackupJob,
  dispatchBackupRestoreJob,
  getBackupCronJobState,
  getBackupJobState,
  releaseBackupOperationLease,
} from "./k8s-job";
import {
  acquireBackupLease,
  BACKUP_RECONCILIATION_LEASE_SECONDS,
  BackupLeaseAcquisitionUncertainError,
  BackupOperationBusyError,
  backupOperationDispatchExpired,
  backupReconciliationLeaseHolder,
  legacyBackupOperationAttempt,
  releaseBackupLeaseWithRetry,
} from "./lock";
import {
  BACKUP_RESTORE_CONFIRMATION,
  BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
  type BackupCreateInput,
  type BackupRestoreInput,
  backupRestoreRecoveryRequired,
  toPublicBackup,
} from "./model";
import { lookupMissingCreateBackupObject } from "./recovery";
import { type BackupObjectMetadata, createBackupDownloadUrl } from "./s3";

async function durableBackupAttemptIsActive(
  backupId: string,
  operation: BackupOperation,
  attemptId: string,
): Promise<boolean> {
  const [activeAttempt] = await db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.id, backupId), backupOperationAttemptClaim(operation, attemptId)))
    .limit(1);
  return activeAttempt !== undefined;
}

type LegacyCreateStoragePathClaim =
  | { kind: "claimed"; backup: typeof backups.$inferSelect }
  | { kind: "canonical"; canonicalBackupId: string }
  | { kind: "stale" };

function postgresErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    candidate = record.cause;
  }
  return undefined;
}

async function claimLegacyCreateStoragePath(
  backupId: string,
  operationAttemptId: string,
  storagePath: string,
): Promise<LegacyCreateStoragePathClaim> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [claimed] = await db
        .update(backups)
        .set({ storagePath })
        .where(
          and(
            eq(backups.id, backupId),
            backupOperationAttemptClaim("create", operationAttemptId),
            eq(backups.storagePath, ""),
          ),
        )
        .returning();
      if (claimed) return { kind: "claimed", backup: claimed };
    } catch (error) {
      if (postgresErrorCode(error) !== "23505") throw error;
    }

    const [canonical] = await db
      .select()
      .from(backups)
      .where(eq(backups.storagePath, storagePath))
      .limit(1);
    if (canonical?.id === backupId) {
      return backupOperationAttemptMatches(canonical, "create", operationAttemptId)
        ? { kind: "claimed", backup: canonical }
        : { kind: "stale" };
    }
    if (canonical) return { kind: "canonical", canonicalBackupId: canonical.id };

    const [current] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (!current || !backupOperationAttemptMatches(current, "create", operationAttemptId)) {
      return { kind: "stale" };
    }
    if (current.storagePath) return { kind: "stale" };
  }

  return { kind: "stale" };
}

function legacyBackupOperationNeedsAdoption(backup: typeof backups.$inferSelect): boolean {
  return (
    (backup.status === "pending" || backup.status === "in_progress") &&
    backup.activeOperation === null &&
    backup.activeOperationAttemptId === null &&
    backup.activeOperationStartedAt === null
  );
}

async function adoptLegacyBackupOperation(
  backup: typeof backups.$inferSelect,
): Promise<typeof backups.$inferSelect> {
  if (!legacyBackupOperationNeedsAdoption(backup)) return backup;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(backups)
      .where(eq(backups.id, backup.id))
      .for("update");
    if (!current || !legacyBackupOperationNeedsAdoption(current)) return current ?? backup;
    if (current.status !== "pending" && current.status !== "in_progress") return current;
    const adoptionStatus = current.status;

    const [latestRestoreEvent] =
      current.status === "in_progress"
        ? await tx
            .select({ eventType: backupLogs.eventType, createdAt: backupLogs.createdAt })
            .from(backupLogs)
            .where(
              and(
                eq(backupLogs.backupId, current.id),
                inArray(backupLogs.eventType, [
                  "restore_started",
                  "restore_completed",
                  "restore_failed",
                ]),
              ),
            )
            .orderBy(desc(backupLogs.createdAt), desc(backupLogs.id))
            .limit(1)
        : [];
    const latestRestoreEventType = latestRestoreEvent?.eventType;
    const operation = inferLegacyBackupOperation(
      adoptionStatus,
      latestRestoreEventType === "restore_started" ||
        latestRestoreEventType === "restore_completed" ||
        latestRestoreEventType === "restore_failed"
        ? latestRestoreEventType
        : null,
    );
    if (!operation) return current;

    const [latestDeleteFailure] =
      operation === "delete"
        ? await tx
            .select({ createdAt: backupLogs.createdAt })
            .from(backupLogs)
            .where(
              and(
                eq(backupLogs.backupId, current.id),
                // The pre-0013 reconciler reported a failed delete Job as
                // backup_failed, while dispatch failure used delete_failed.
                // Either event fences a later retry from the retained Job.
                inArray(backupLogs.eventType, ["delete_failed", "backup_failed"]),
              ),
            )
            .orderBy(desc(backupLogs.createdAt), desc(backupLogs.id))
            .limit(1)
        : [];

    const adoptedAt = new Date();
    const operationStartedAt =
      operation === "create"
        ? current.createdAt
        : operation === "restore"
          ? (latestRestoreEvent?.createdAt ?? adoptedAt)
          : (latestDeleteFailure?.createdAt ?? current.createdAt);
    const attemptId = runtimeLegacyBackupAttemptId(adoptedAt, crypto.randomUUID());
    const [adopted] = await tx
      .update(backups)
      .set({
        activeOperation: operation,
        activeOperationAttemptId: attemptId,
        activeOperationStartedAt: operationStartedAt,
      })
      .where(and(eq(backups.id, current.id), legacyBackupOperationAdoptionClaim(adoptionStatus)))
      .returning();

    return adopted ?? current;
  });
}

export abstract class BackupService {
  private static readonly OPERATION_POLL_INTERVAL_MS = 2_000;
  private static readonly OPERATION_POLL_LIMIT = 4_800;

  static async getAllByServer(userId: string, serverId: string) {
    await ServerService.requireOwnership(userId, serverId);
    const allBackups = await db
      .select()
      .from(backups)
      .where(and(eq(backups.serverId, serverId), ne(backups.status, "deleted")))
      .orderBy(desc(backups.createdAt));
    const reconciled = await Promise.all(
      allBackups.map((backup) => this.reconcileBackupOperation(backup)),
    );
    return reconciled.map(toPublicBackup);
  }

  static async getById(userId: string, serverId: string, backupId: string) {
    await ServerService.requireOwnership(userId, serverId);
    let [backup] = await db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          eq(backups.id, backupId),
          ne(backups.status, "deleted"),
        ),
      );
    if (!backup) throw status(404, "Backup not found");

    backup = await this.reconcileBackupOperation(backup);

    const logs = await db
      .select({
        id: backupLogs.id,
        level: backupLogs.level,
        eventType: backupLogs.eventType,
        message: backupLogs.message,
        createdAt: backupLogs.createdAt,
      })
      .from(backupLogs)
      .where(eq(backupLogs.backupId, backupId))
      .orderBy(desc(backupLogs.createdAt));
    return {
      ...toPublicBackup(backup),
      logs,
    };
  }

  static async getSchedule(userId: string, serverId: string, now: Date = new Date()) {
    const server = await ServerService.requireOwnership(userId, serverId);
    const supported = server.game === "minecraft";
    const configuredSchedule = resolveBackupScheduleConfig();
    const cronJob = await getBackupCronJobState();
    const expectedCron = `${configuredSchedule.minute} ${configuredSchedule.hour} * * ${configuredSchedule.dayOfWeek}`;
    const cronMatches =
      cronJob.exists &&
      cronJob.schedule === expectedCron &&
      ["Etc/UTC", "UTC"].includes(cronJob.timeZone ?? "Etc/UTC");
    const schedule = {
      ...configuredSchedule,
      enabled: supported && configuredSchedule.enabled && cronMatches && !cronJob.suspended,
    };
    const [lastSuccessful] = await db
      .select({ completedAt: backups.completedAt })
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          eq(backups.source, "scheduled"),
          eq(backups.status, "completed"),
          isNotNull(backups.completedAt),
        ),
      )
      .orderBy(desc(backups.completedAt))
      .limit(1);

    const lastSuccessfulAt = lastSuccessful?.completedAt ?? null;
    const lastAttemptAt = cronJob.lastScheduleAt;
    const health = backupScheduleHealth(schedule.enabled, lastAttemptAt, lastSuccessfulAt, now);

    return {
      ...schedule,
      supported,
      health,
      lastAttemptAt,
      nextRunAt: nextWeeklyBackupRun(schedule, now),
      lastSuccessfulAt,
      statusMessage: !supported
        ? "Automatic backups currently support Minecraft Java realms only."
        : health === "degraded"
          ? "The latest weekly run did not produce a recovery point."
          : health === "pending"
            ? "The scheduler is active and waiting for a verified recovery point."
            : health === "disabled"
              ? "The weekly scheduler is missing, suspended, or differs from this policy."
              : "The latest weekly run produced a verified recovery point.",
    };
  }

  static async getDownload(userId: string, serverId: string, backupId: string) {
    await ServerService.requireOwnership(userId, serverId);
    const [backup] = await db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          eq(backups.id, backupId),
          eq(backups.status, "completed"),
        ),
      )
      .limit(1);

    if (!backup) throw status(404, "Backup not found");
    if (!backup.storagePath.trim()) {
      throw status(409, "Backup has no storage object to download");
    }

    return createBackupDownloadUrl(backup.storagePath, backup.name);
  }

  static async reconcileServerOperations(serverId: string) {
    const activeBackups = await db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          or(
            isNotNull(backups.activeOperation),
            inArray(backups.status, ["pending", "in_progress"]),
          ),
        ),
      );

    return Promise.all(activeBackups.map((backup) => this.reconcileBackupOperation(backup)));
  }

  static async resumeOperationMonitors() {
    const operationCandidates = await db
      .select()
      .from(backups)
      .where(
        or(isNotNull(backups.activeOperation), inArray(backups.status, ["pending", "in_progress"])),
      );

    // Adoption completes before startup is allowed to serve requests. This
    // closes the rollout window where an old API writes a triple-null operation
    // after migration 0015 has run but before the new reconciler starts.
    const activeBackups = (
      await Promise.all(operationCandidates.map((backup) => adoptLegacyBackupOperation(backup)))
    ).filter((backup) => backup.activeOperation !== null);
    for (const backup of activeBackups) this.startBackupOperationMonitor(backup.id);
    return activeBackups.length;
  }

  private static async monitorBackupOperation(backupId: string) {
    for (let attempt = 0; attempt < this.OPERATION_POLL_LIMIT; attempt += 1) {
      const [backup] = await db.select().from(backups).where(eq(backups.id, backupId));

      if (!backup) return;

      try {
        const reconciled = await this.reconcileBackupOperation(backup);
        if (!reconciled.activeOperation) return;
      } catch (error) {
        console.error(`[backup] Reconciliation attempt failed for '${backupId}':`, error);
      }

      await new Promise((resolve) => setTimeout(resolve, this.OPERATION_POLL_INTERVAL_MS));
    }

    console.error(`[backup] Timed out waiting to reconcile backup operation '${backupId}'`);
  }

  private static startBackupOperationMonitor(backupId: string) {
    void this.monitorBackupOperation(backupId).catch((error) => {
      // Read-time reconciliation and server-action recovery remain available if
      // this process is restarted or temporarily loses Kubernetes connectivity.
      console.error(`[backup] Background reconciliation failed for '${backupId}':`, error);
    });
  }

  private static async reconcileBackupOperation(backup: typeof backups.$inferSelect) {
    backup = await adoptLegacyBackupOperation(backup);
    const operation = backup.activeOperation;
    const attemptId = backup.activeOperationAttemptId;
    if (!operation || !attemptId) {
      return backup;
    }

    const k8sRecord = await db.query.serverK8s.findFirst({
      columns: { namespace: true },
      where: eq(serverK8s.serverId, backup.serverId),
    });
    if (!k8sRecord) return backup;

    const observedJobState = await getBackupJobState(
      backup.id,
      backup.serverId,
      k8sRecord.namespace,
      operation,
      attemptId,
      backup.activeOperationStartedAt,
    );
    let missingJobReconciliationHolder: string | null = null;
    if (observedJobState.status === "missing") {
      const runtimeAdoptedAt = runtimeLegacyBackupAttemptAdoptedAt(attemptId);
      if (
        !backupOperationDispatchExpired(
          runtimeAdoptedAt ?? backup.activeOperationStartedAt,
          backup.createdAt,
        )
      ) {
        return backup;
      }
      missingJobReconciliationHolder = backupReconciliationLeaseHolder(
        operation,
        attemptId,
        crypto.randomUUID(),
      );
      try {
        // Take the expired/missing Lease with a holder distinct from the
        // dispatcher before declaring the Job absent. Kubernetes' resource-
        // version CAS makes a paused dispatcher renewal and this takeover
        // mutually exclusive; uncertainty always retries without finalizing.
        await acquireBackupLease(
          k8sRecord.namespace,
          backup.serverId,
          missingJobReconciliationHolder,
          BACKUP_RECONCILIATION_LEASE_SECONDS,
        );
      } catch (error) {
        if (
          error instanceof BackupOperationBusyError ||
          error instanceof BackupLeaseAcquisitionUncertainError
        ) {
          return backup;
        }
        throw error;
      }
    }

    const releaseMissingJobFence = async (): Promise<boolean> => {
      if (!missingJobReconciliationHolder) return true;
      try {
        await releaseBackupLeaseWithRetry(
          k8sRecord.namespace,
          backup.serverId,
          missingJobReconciliationHolder,
        );
        return true;
      } catch (error) {
        console.error(
          `[backup] Failed to release missing-Job reconciliation lease '${backup.id}':`,
          error,
        );
        return false;
      }
    };

    let effectiveBackup = backup;
    let canonicalStorageBackupId: string | null = null;
    let terminalCreateStoragePathMissing = false;
    if (
      operation === "create" &&
      legacyBackupOperationAttempt(attemptId) &&
      observedJobState.status === "completed" &&
      !backup.storagePath.trim()
    ) {
      if (!observedJobState.storagePath) {
        terminalCreateStoragePathMissing = true;
      } else {
        const storagePathClaim = await claimLegacyCreateStoragePath(
          backup.id,
          attemptId,
          observedJobState.storagePath,
        );
        if (storagePathClaim.kind === "stale") {
          await releaseMissingJobFence();
          return backup;
        }
        if (storagePathClaim.kind === "claimed") {
          effectiveBackup = storagePathClaim.backup;
        } else {
          canonicalStorageBackupId = storagePathClaim.canonicalBackupId;
        }
      }
    }

    const missingJob = observedJobState.status === "missing";
    let recoveredCreateObject: BackupObjectMetadata | null = null;
    if (missingJob && operation === "create") {
      try {
        // Legacy create Jobs used a one-hour TTL and can disappear before the
        // first post-migration reconciliation. S3 is strongly consistent for
        // an exact key, so a valid non-empty HEAD response is authoritative
        // evidence that the recovery point finished uploading.
        recoveredCreateObject = await lookupMissingCreateBackupObject(
          operation,
          backup.storagePath,
        );
      } catch (error) {
        // Permission, throttling, and transport failures are not evidence that
        // the archive is absent. Retain the durable attempt for a later retry.
        console.error(
          `[backup] Could not verify exact storage key for missing create Job '${backup.id}':`,
          error,
        );
        await releaseMissingJobFence();
        return backup;
      }
    }

    const recoveredMissingCreate = missingJob && recoveredCreateObject !== null;
    const jobState = terminalCreateStoragePathMissing
      ? ({
          status: "failed",
          jobName: "jobName" in observedJobState ? observedJobState.jobName : "unavailable",
          operation,
        } as const)
      : missingJob
        ? recoveredMissingCreate
          ? ({ status: "completed", jobName: "storage-exact-key", operation } as const)
          : ({ status: "failed", jobName: "unavailable", operation } as const)
        : observedJobState;
    if (jobState.status === "pending") return backup;

    if (jobState.operation !== operation) return backup;

    const catalogDeduplicated = canonicalStorageBackupId !== null;
    const operationCompleted = jobState.status === "completed" && !catalogDeduplicated;
    const deleted = operation === "delete" && operationCompleted;
    const restored = operation === "restore" && operationCompleted;
    const restoreFailed = operation === "restore" && !operationCompleted;
    // Any failed restore retains a durable start blocker. Failures before the
    // PVC switch can be retried safely; failures after a partial switch keep
    // failing the restore script while rollback data is present. Only a
    // successful restore clears this sentinel.
    const restoreNeedsManualRecovery = restoreFailed;
    const deleteFailed = operation === "delete" && !operationCompleted;
    const newStatus = catalogDeduplicated
      ? "deleted"
      : backupOperationTerminalStatus(
          operation,
          operationCompleted,
          effectiveBackup.status,
          effectiveBackup.completedAt,
          effectiveBackup.storagePath,
        );
    const eventType = catalogDeduplicated
      ? "backup_deleted"
      : deleted
        ? "backup_deleted"
        : deleteFailed
          ? "delete_failed"
          : restored
            ? "restore_completed"
            : restoreFailed
              ? "restore_failed"
              : operationCompleted
                ? "backup_completed"
                : "backup_failed";
    const level = catalogDeduplicated ? "warn" : jobState.status === "failed" ? "error" : "info";
    const message = catalogDeduplicated
      ? `Backup '${backup.name}' was consolidated into the existing exact-key catalog record '${canonicalStorageBackupId}'.`
      : terminalCreateStoragePathMissing
        ? `Backup '${backup.name}' failed because its completed legacy Kubernetes Job did not contain a valid storage key.`
        : recoveredMissingCreate
          ? `Backup '${backup.name}' completed; its exact archive was verified in storage after the Kubernetes Job record expired.`
          : missingJob
            ? operation === "restore"
              ? `Restore failed for Backup '${backup.name}' because its Kubernetes Job was not created.`
              : operation === "delete"
                ? `Backup '${backup.name}' could not be deleted because its Kubernetes Job was not created.`
                : `Backup '${backup.name}' failed because its Kubernetes Job was not created.`
            : deleted
              ? `Backup '${backup.name}' was deleted by Kubernetes Job '${jobState.jobName}'.`
              : deleteFailed
                ? `Backup '${backup.name}' could not be deleted by Kubernetes Job '${jobState.jobName}'.`
                : restored
                  ? `Restore completed with Backup '${backup.name}' in Kubernetes Job '${jobState.jobName}'.`
                  : restoreFailed
                    ? `Restore failed for Backup '${backup.name}' in Kubernetes Job '${jobState.jobName}'.`
                    : jobState.status === "completed"
                      ? `Backup '${backup.name}' completed in Kubernetes Job '${jobState.jobName}'.`
                      : `Backup '${backup.name}' failed in Kubernetes Job '${jobState.jobName}'.`;

    const operationClaim = backupOperationAttemptClaim(operation, attemptId);

    // Persist the terminal Job outcome while retaining the database claim. If
    // Lease release is temporarily unavailable, the monitor can safely retry
    // without allowing a newer server lifecycle operation to start first.
    const [terminalBackup] = await db
      .update(backups)
      .set({
        status: newStatus,
        storagePath: deleted || catalogDeduplicated ? "" : effectiveBackup.storagePath,
        sizeBytes: recoveredCreateObject?.sizeBytes ?? effectiveBackup.sizeBytes,
        completedAt:
          operation === "create" && newStatus === "completed"
            ? (recoveredCreateObject?.completedAt ?? new Date())
            : effectiveBackup.completedAt,
      })
      .where(and(eq(backups.id, backup.id), operationClaim))
      .returning();

    if (!terminalBackup || !backupOperationAttemptMatches(terminalBackup, operation, attemptId)) {
      await releaseMissingJobFence();
      return backup;
    }

    if (!missingJobReconciliationHolder) {
      try {
        await releaseBackupOperationLease(
          k8sRecord.namespace,
          backup.serverId,
          backup.id,
          operation,
          attemptId,
        );
      } catch (error) {
        console.error(
          `[backup] Failed to release completed operation lease '${backup.id}':`,
          error,
        );
        return terminalBackup;
      }
    }

    const terminalOperationClaim = and(
      backupOperationAttemptClaim(operation, attemptId),
      eq(backups.status, newStatus),
    );

    const [updatedBackup] = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(backups)
        .set({
          activeOperation: null,
          activeOperationAttemptId: null,
          activeOperationStartedAt: null,
        })
        .where(and(eq(backups.id, backup.id), terminalOperationClaim))
        .returning();

      if (!updated) return [terminalBackup];

      if (operation === "restore") {
        await tx
          .update(gameServers)
          .set({
            currentState: restoreNeedsManualRecovery ? "failed" : "stopped",
            desiredState: "stopped",
            statusMessage: restoreNeedsManualRecovery
              ? BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE
              : restoreFailed
                ? "Backup restore failed"
                : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(gameServers.id, backup.serverId),
              eq(gameServers.currentState, "restarting"),
              eq(gameServers.desiredState, "stopped"),
              or(
                eq(gameServers.statusMessage, "Restoring backup"),
                eq(gameServers.statusMessage, BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE),
              ),
            ),
          );
      }

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: backup.id,
        serverId: backup.serverId,
        level,
        eventType,
        message,
        metadata: catalogDeduplicated
          ? {
              operation: jobState.operation,
              reason: "duplicate_storage_path",
              canonicalBackupId: canonicalStorageBackupId,
              storagePath:
                observedJobState.status === "completed" ? observedJobState.storagePath : undefined,
            }
          : terminalCreateStoragePathMissing
            ? {
                operation: jobState.operation,
                reason: "legacy_job_storage_path_missing_or_invalid",
              }
            : recoveredCreateObject !== null
              ? {
                  operation: jobState.operation,
                  reason: "job_record_expired_after_upload",
                  reconciledFrom: "s3_exact_key",
                  sizeBytes: recoveredCreateObject.sizeBytes,
                }
              : missingJob
                ? { operation: jobState.operation, reason: "job_not_created" }
                : { jobName: jobState.jobName, operation: jobState.operation },
      });

      return [updated];
    });

    // A missing-Job takeover remains held until the durable attempt claim is
    // cleared, so a dispatcher paused before its final renew/create cannot
    // resume in the release-to-finalization gap.
    await releaseMissingJobFence();
    return updatedBackup;
  }

  static async create(userId: string, serverId: string, data: BackupCreateInput) {
    const ownedServer = await ServerService.requireOwnership(userId, serverId);
    if (ownedServer.game !== "minecraft") {
      throw status(409, "Backups currently support Minecraft Java realms only");
    }
    const { prefix: s3Prefix } = resolveBackupStorageConfig();
    const startedAt = new Date();
    const attemptId = crypto.randomUUID();
    const timeString = startedAt.toISOString().split(".")[0].replace(/:/g, "-").replace("T", "_");
    const timestamp = startedAt
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const archiveFile = `${serverId}-${timestamp}.tar.gz`;
    const storagePath = `${s3Prefix}/${serverId}/${archiveFile}`;

    const pendingBackup = await db.transaction(async (tx) => {
      const [server] = await tx
        .select({
          currentState: gameServers.currentState,
          statusMessage: gameServers.statusMessage,
        })
        .from(gameServers)
        .where(eq(gameServers.id, serverId))
        .for("update");

      if (server?.currentState !== "running") {
        throw status(409, "Server must be running before creating a backup");
      }

      await reconcileTimeBoundEntitlementInTransaction(userId, new Date(), tx);
      const [quota] = await tx
        .select({ backupLimits: userQuotas.backupsLimit })
        .from(userQuotas)
        .where(eq(userQuotas.userId, userId))
        .for("update");

      if (!quota) throw status(404, "No quota found for this account.");

      const [manualBackupUsage] = await tx
        .select({ total: count() })
        .from(backups)
        .innerJoin(gameServers, eq(backups.serverId, gameServers.id))
        .where(
          and(
            eq(gameServers.userId, userId),
            ne(gameServers.currentState, "deleted"),
            eq(backups.source, "manual"),
            notInArray(backups.status, ["deleted", "failed"]),
          ),
        );

      if (manualBackupUsage.total >= quota.backupLimits) {
        throw status(
          403,
          `Manual backup limit reached (${manualBackupUsage.total}/${quota.backupLimits})`,
        );
      }

      const [existingPending] = await tx
        .select({ id: backups.id })
        .from(backups)
        .where(
          and(
            eq(backups.serverId, serverId),
            or(
              isNotNull(backups.activeOperation),
              inArray(backups.status, ["pending", "in_progress"]),
            ),
          ),
        );

      if (existingPending) {
        throw status(409, "A backup is already in progress for this server");
      }
      const [newBackup] = await tx
        .insert(backups)
        .values({
          id: crypto.randomUUID(),
          serverId: serverId,
          name: data.name || `Manual backup ${timeString}`,
          storagePath,
          sizeBytes: 0,
          status: "pending",
          source: "manual",
          activeOperation: "create",
          activeOperationAttemptId: attemptId,
          activeOperationStartedAt: startedAt,
        })
        .returning();

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: newBackup.id,
        serverId: serverId,
        level: "info",
        eventType: "backup_started",
        message: `Backup '${newBackup.name}' started.`,
        metadata: { sizeBytes: 0 },
      });
      return newBackup;
    });
    try {
      // Look up the PVC name for this server so we can tell the K8s job
      // which volume to archive.
      const k8sRecord = await db.query.serverK8s.findFirst({
        where: eq(serverK8s.serverId, serverId),
      });

      if (!k8sRecord) {
        throw new Error(`No Kubernetes record found for server '${serverId}'`);
      }

      // Dispatch the K8s Job (same image/command pattern as the cronjob).
      // This returns immediately; the job runs in the background.
      await dispatchBackupJob(
        pendingBackup.id,
        serverId,
        k8sRecord.namespace,
        attemptId,
        () => durableBackupAttemptIsActive(pendingBackup.id, "create", attemptId),
        async () => {
          const latest = await db.query.serverK8s.findFirst({
            columns: { namespace: true, serviceName: true },
            where: eq(serverK8s.serverId, serverId),
          });
          if (!latest || latest.namespace !== k8sRecord.namespace) {
            throw new Error(`Kubernetes target changed while backing up server '${serverId}'`);
          }
          return latest.serviceName;
        },
        storagePath,
      );
      this.startBackupOperationMonitor(pendingBackup.id);

      return toPublicBackup(pendingBackup);
    } catch (error) {
      console.error(`[backup] Failed to dispatch create job for '${pendingBackup.id}':`, error);
      await db.transaction(async (tx) => {
        const [failedBackup] = await tx
          .update(backups)
          .set({
            status: "failed",
            activeOperation: null,
            activeOperationAttemptId: null,
            activeOperationStartedAt: null,
          })
          .where(
            and(eq(backups.id, pendingBackup.id), backupOperationAttemptClaim("create", attemptId)),
          )
          .returning();

        if (!failedBackup) return;

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: failedBackup.id,
          serverId: serverId,
          level: "error",
          eventType: "backup_failed",
          message: `Backup '${failedBackup.name}' creation failed.`,
        });
      });
      if (
        error instanceof BackupOperationBusyError ||
        (error instanceof BackupJobNotStartedError &&
          error.cause instanceof ServerCutoverInProgressError)
      ) {
        throw status(409, "Another backup or restore operation is already active for this server");
      }
      throw status(500, "Backup creation failed.");
    }
  }

  static async restore(id: string, serverId: string, userId: string, input: BackupRestoreInput) {
    if (input.confirmation !== BACKUP_RESTORE_CONFIRMATION) {
      throw status(400, "Backup restore requires explicit data-loss confirmation");
    }
    const ownedServer = await ServerService.requireOwnership(userId, serverId);
    if (ownedServer.game !== "minecraft") {
      throw status(409, "Restores currently support Minecraft Java realms only");
    }
    const restoreAttemptId = crypto.randomUUID();
    const restoreStartedAt = new Date();
    const restoreBackup = await db.transaction(async (tx) => {
      const [server] = await tx
        .select({
          currentState: gameServers.currentState,
          statusMessage: gameServers.statusMessage,
        })
        .from(gameServers)
        .where(eq(gameServers.id, serverId))
        .for("update");

      // The recovery sentinel is authoritative across lifecycle state changes.
      // In particular, a valid stop can leave the server in `stopped` while
      // preserving the sentinel; a retry must still fail closed in that state.
      const retryingRecovery = backupRestoreRecoveryRequired(server?.statusMessage);
      if (
        server?.currentState !== "ready" &&
        server?.currentState !== "stopped" &&
        !retryingRecovery
      ) {
        throw status(409, "Server must be stopped before restoring a backup");
      }

      const [backup] = await tx
        .select()
        .from(backups)
        .where(
          and(
            eq(backups.serverId, serverId),
            eq(backups.id, id),
            eq(backups.status, "completed"),
            isNull(backups.activeOperation),
          ),
        )
        .for("update");

      if (!backup) throw status(404, "Backup not found");
      if (!backup.storagePath.trim()) {
        throw status(409, "Backup has no storage object to restore");
      }

      // Claim both records in the same transaction. The transitional server
      // state prevents a concurrent start from mounting the PVC mid-restore.
      await tx
        .update(backups)
        .set({
          activeOperation: "restore",
          activeOperationAttemptId: restoreAttemptId,
          activeOperationStartedAt: restoreStartedAt,
        })
        .where(eq(backups.id, id));

      await tx
        .update(gameServers)
        .set({
          currentState: "restarting",
          desiredState: "stopped",
          statusMessage: retryingRecovery
            ? BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE
            : "Restoring backup",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: backup.id,
        serverId: serverId,
        level: "info",
        eventType: "restore_started",
        message: `Restore started with Backup '${backup.name}'`,
        metadata: {},
      });
      return {
        ...backup,
        activeOperation: "restore" as const,
        activeOperationAttemptId: restoreAttemptId,
        activeOperationStartedAt: restoreStartedAt,
        retryingRecovery,
      };
    });
    try {
      const k8sRecord = await db.query.serverK8s.findFirst({
        where: eq(serverK8s.serverId, serverId),
      });

      if (!k8sRecord) {
        throw new Error(`No Kubernetes record found for server '${serverId}'`);
      }

      await dispatchBackupRestoreJob(
        restoreBackup.id,
        serverId,
        k8sRecord.namespace,
        restoreAttemptId,
        () => durableBackupAttemptIsActive(restoreBackup.id, "restore", restoreAttemptId),
        restoreBackup.storagePath,
        async () => {
          const latest = await db.query.serverK8s.findFirst({
            columns: { deploymentName: true, namespace: true, pvcName: true },
            where: eq(serverK8s.serverId, serverId),
          });
          if (!latest || latest.namespace !== k8sRecord.namespace) {
            throw new Error(`Kubernetes target changed while restoring server '${serverId}'`);
          }
          return {
            deploymentName: latest.deploymentName,
            pvcName: latest.pvcName,
          };
        },
      );
      this.startBackupOperationMonitor(restoreBackup.id);

      return toPublicBackup(restoreBackup);
    } catch (error) {
      console.error(`[backup] Failed to dispatch restore job for '${restoreBackup.id}':`, error);
      const definitelyNotStarted =
        error instanceof BackupOperationBusyError || error instanceof BackupJobNotStartedError;
      await db.transaction(async (tx) => {
        const [clearedRestore] = await tx
          .update(backups)
          .set({
            status: "completed",
            activeOperation: null,
            activeOperationAttemptId: null,
            activeOperationStartedAt: null,
          })
          .where(
            and(
              eq(backups.id, restoreBackup.id),
              backupOperationAttemptClaim("restore", restoreAttemptId),
            ),
          )
          .returning({ id: backups.id });

        // Another lifecycle operation may have superseded this restore while
        // its Job dispatch was waiting for the Lease. Never overwrite that
        // newer state or emit a duplicate terminal event.
        if (!clearedRestore) return;

        await tx
          .update(gameServers)
          .set({
            currentState:
              definitelyNotStarted && !restoreBackup.retryingRecovery ? "stopped" : "failed",
            desiredState: "stopped",
            statusMessage:
              definitelyNotStarted && !restoreBackup.retryingRecovery
                ? null
                : BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(gameServers.id, serverId),
              eq(gameServers.currentState, "restarting"),
              eq(gameServers.desiredState, "stopped"),
              inArray(gameServers.statusMessage, [
                "Restoring backup",
                BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
              ]),
            ),
          );

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: restoreBackup.id,
          serverId: serverId,
          level: "error",
          eventType: "restore_failed",
          message: `Restore failed for Backup '${restoreBackup.name}'`,
        });
      });
      if (
        error instanceof BackupOperationBusyError ||
        (error instanceof BackupJobNotStartedError &&
          error.cause instanceof ServerCutoverInProgressError)
      ) {
        throw status(409, "Another backup or restore operation is already active for this server");
      }
      throw status(500, "Failed to restore backup.");
    }
  }

  static async delete(id: string, serverId: string, userId: string) {
    // Verify server ownership
    await ServerService.requireOwnership(userId, serverId);
    const deleteAttemptId = crypto.randomUUID();
    const deleteStartedAt = new Date();
    const backup = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(backups)
        .where(and(eq(backups.id, id), eq(backups.serverId, serverId)))
        .for("update");

      if (!existing || existing.status === "deleted") throw status(404, "Backup not found");
      if (
        existing.activeOperation ||
        existing.status === "in_progress" ||
        existing.status === "pending"
      )
        throw status(409, "This backup has an operation in progress, please try again later");

      if (!existing.storagePath.trim()) {
        const [deleted] = await tx
          .update(backups)
          .set({
            storagePath: "",
            status: "deleted",
            activeOperation: null,
            activeOperationAttemptId: null,
            activeOperationStartedAt: null,
          })
          .where(eq(backups.id, id))
          .returning();

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: existing.id,
          serverId: existing.serverId,
          level: "info",
          eventType: "backup_deleted",
          message: `Backup '${existing.name}' was removed without a storage deletion because it has no storage object.`,
          metadata: { operation: "delete", storageObjectExisted: false },
        });

        return {
          ...deleted,
          previousStatus: existing.status,
          requiresStorageDeletion: false,
        };
      }

      const [updated] = await tx
        .update(backups)
        .set({
          activeOperation: "delete",
          activeOperationAttemptId: deleteAttemptId,
          activeOperationStartedAt: deleteStartedAt,
        })
        .where(eq(backups.id, id))
        .returning();

      return {
        ...updated,
        previousStatus: existing.status,
        requiresStorageDeletion: true,
      };
    });

    if (!backup.requiresStorageDeletion) return toPublicBackup(backup);

    try {
      const k8sRecord = await db.query.serverK8s.findFirst({
        columns: { namespace: true },
        where: eq(serverK8s.serverId, serverId),
      });
      if (!k8sRecord) {
        throw new Error(`No Kubernetes record found for server '${serverId}'`);
      }

      await dispatchBackupDeleteJob(
        id,
        backup.serverId,
        k8sRecord.namespace,
        deleteAttemptId,
        () => durableBackupAttemptIsActive(id, "delete", deleteAttemptId),
        backup.storagePath,
      );
      this.startBackupOperationMonitor(backup.id);

      return toPublicBackup(backup);
    } catch (error) {
      console.error(`[backup] Failed to dispatch delete job for '${backup.id}':`, error);
      await db.transaction(async (tx) => {
        const [rolledBack] = await tx
          .update(backups)
          .set({
            status: backup.previousStatus,
            activeOperation: null,
            activeOperationAttemptId: null,
            activeOperationStartedAt: null,
          })
          .where(and(eq(backups.id, id), backupOperationAttemptClaim("delete", deleteAttemptId)))
          .returning({ id: backups.id });
        if (!rolledBack) return;
        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: backup.id,
          serverId: backup.serverId,
          level: "error",
          eventType: "delete_failed",
          message: `Failed to delete Backup '${backup.name}'.`,
          metadata: {},
        });
      });
      if (
        error instanceof BackupOperationBusyError ||
        (error instanceof BackupJobNotStartedError &&
          error.cause instanceof ServerCutoverInProgressError)
      ) {
        throw status(409, "Another backup or restore operation is already active for this server");
      }
      throw status(500, "Failed to delete backup from storage.");
    }
  }
}
