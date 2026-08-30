import { backupLogs, backups, gameServers, serverK8s } from "@repo/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "../../db";
import { backupOperationAttemptClaim } from "./attempt";
import { parseBackupStorageKey, resolveBackupStorageConfig } from "./config";
import { releaseBackupOperationLease } from "./k8s-job";
import { backupObjectExists, listBackups } from "./s3";

async function reconcileObject(
  object: { Key?: string; LastModified?: Date; Size?: number },
  configuredPrefix: string,
): Promise<void> {
  if (!object.Key) return;

  const parsedKey = parseBackupStorageKey(object.Key, configuredPrefix);
  if (!parsedKey) return;

  const { serverId, filename, source } = parsedKey;
  const completedAt = object.LastModified ?? new Date();
  const sizeBytes = Number(object.Size ?? 0);
  const [existing] = await db.select().from(backups).where(eq(backups.storagePath, object.Key));

  if (existing) {
    if (existing.status === "pending" || existing.activeOperation === "create") {
      const attemptId = existing.activeOperationAttemptId;
      if (existing.activeOperation === "create" && !attemptId) {
        console.warn(
          `[backup-sync] Active create '${existing.id}' has no durable attempt ID; deferring reconciliation`,
        );
        return;
      }
      // First persist the durable object without dropping the operation claim.
      // That keeps other server actions blocked until the matching Lease has
      // been released. A failed Lease release is retried on the next sync.
      const transitionClaim =
        existing.activeOperation === "create"
          ? backupOperationAttemptClaim("create", attemptId!)
          : and(isNull(backups.activeOperation), eq(backups.status, "pending"));
      const [transitioned] = await db
        .update(backups)
        .set({ status: "completed", sizeBytes, completedAt })
        .where(and(eq(backups.id, existing.id), transitionClaim))
        .returning({
          id: backups.id,
          activeOperation: backups.activeOperation,
          activeOperationAttemptId: backups.activeOperationAttemptId,
        });

      if (!transitioned) return;

      if (transitioned.activeOperation === "create") {
        if (!transitioned.activeOperationAttemptId) return;
        const k8sRecord = await db.query.serverK8s.findFirst({
          columns: { namespace: true },
          where: eq(serverK8s.serverId, existing.serverId),
        });
        if (k8sRecord) {
          await releaseBackupOperationLease(
            k8sRecord.namespace,
            existing.serverId,
            existing.id,
            "create",
            transitioned.activeOperationAttemptId,
          );
        } else {
          console.warn(
            `[backup-sync] Kubernetes record is missing while completing '${existing.id}'`,
          );
          return;
        }
      }

      await db.transaction(async (tx) => {
        const operationClaim =
          transitioned.activeOperation === "create"
            ? backupOperationAttemptClaim("create", transitioned.activeOperationAttemptId!)
            : and(isNull(backups.activeOperation), eq(backups.status, "completed"));
        const [cleared] = await tx
          .update(backups)
          .set({
            activeOperation: null,
            activeOperationAttemptId: null,
            activeOperationStartedAt: null,
          })
          .where(and(eq(backups.id, existing.id), operationClaim))
          .returning({ id: backups.id });

        if (!cleared) return;

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: existing.id,
          serverId: existing.serverId,
          level: "info",
          eventType: "backup_completed",
          message: `Backup '${existing.name}' completed.`,
          metadata: { sizeBytes, reconciledFrom: "s3" },
        });
      });
    } else if (
      existing.status === "completed" &&
      (existing.sizeBytes !== sizeBytes || !existing.completedAt)
    ) {
      await db
        .update(backups)
        .set({ sizeBytes, completedAt: existing.completedAt ?? completedAt })
        .where(eq(backups.id, existing.id));
    } else if (
      existing.status === "failed" &&
      existing.activeOperation === null &&
      Number.isSafeInteger(sizeBytes) &&
      sizeBytes > 0 &&
      !Number.isNaN(completedAt.getTime())
    ) {
      // A pre-0013 create Job may have uploaded its exact archive and then
      // disappeared under the old one-hour TTL before the API observed its
      // terminal state. Heal rows already failed by an older reconciler when
      // the complete S3 listing provides the same exact, non-empty key.
      await db.transaction(async (tx) => {
        const [recovered] = await tx
          .update(backups)
          .set({ status: "completed", sizeBytes, completedAt })
          .where(
            and(
              eq(backups.id, existing.id),
              eq(backups.status, "failed"),
              isNull(backups.activeOperation),
              eq(backups.storagePath, object.Key!),
            ),
          )
          .returning({ id: backups.id });

        if (!recovered) return;

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: existing.id,
          serverId: existing.serverId,
          level: "info",
          eventType: "backup_completed",
          message: `Backup '${existing.name}' recovered from its exact archive in storage.`,
          metadata: {
            sizeBytes,
            reason: "failed_catalog_row_with_archive",
            reconciledFrom: "s3_exact_key",
          },
        });
      });
    }

    return;
  }

  // Object keys are external input. Ignore orphaned keys instead of allowing a
  // foreign-key failure to abort reconciliation for every remaining server.
  const server = await db.query.gameServers.findFirst({
    columns: { id: true },
    where: eq(gameServers.id, serverId),
  });
  if (!server) {
    console.warn(`[backup-sync] Ignoring object for unknown server '${serverId}'`);
    return;
  }

  await db.transaction(async (tx) => {
    const id = crypto.randomUUID();
    const [inserted] = await tx
      .insert(backups)
      .values({
        id,
        serverId,
        name: source === "scheduled" ? `Weekly backup ${completedAt.toISOString()}` : filename,
        storagePath: object.Key!,
        sizeBytes,
        status: "completed",
        source,
        activeOperation: null,
        activeOperationAttemptId: null,
        completedAt,
      })
      .onConflictDoNothing()
      .returning({ id: backups.id });

    if (!inserted) return;

    await tx.insert(backupLogs).values({
      id: crypto.randomUUID(),
      backupId: id,
      serverId,
      level: "info",
      eventType: "backup_completed",
      message:
        source === "scheduled"
          ? "Weekly backup imported from storage."
          : `Backup '${filename}' imported from storage.`,
      metadata: { sizeBytes, source, reconciledFrom: "s3" },
    });

    console.info(`[backup-sync] Imported backup '${id}' for server '${serverId}'`);
  });
}

async function reconcileMissingObjects(
  configuredPrefix: string,
  seenStoragePaths: ReadonlySet<string>,
  scanStartedAt: Date,
): Promise<void> {
  const catalogBackups = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.status, "completed"),
        isNull(backups.activeOperation),
        like(backups.storagePath, `${configuredPrefix}/%`),
      ),
    );

  for (const backup of catalogBackups) {
    if (seenStoragePaths.has(backup.storagePath)) continue;
    // A backup completed during this paginated scan may have been uploaded
    // after its prefix page was read. Defer it, and HEAD every older candidate
    // before treating lifecycle expiration as deletion.
    if (!backup.completedAt || backup.completedAt.getTime() >= scanStartedAt.getTime()) continue;
    if (await backupObjectExists(backup.storagePath)) continue;

    await db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(backups)
        .set({
          status: "deleted",
          activeOperation: null,
          activeOperationAttemptId: null,
          activeOperationStartedAt: null,
          storagePath: "",
        })
        .where(
          and(
            eq(backups.id, backup.id),
            eq(backups.status, "completed"),
            isNull(backups.activeOperation),
            eq(backups.storagePath, backup.storagePath),
          ),
        )
        .returning({ id: backups.id });

      if (!deleted) return;

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: backup.id,
        serverId: backup.serverId,
        level: "info",
        eventType: "backup_deleted",
        message:
          backup.source === "scheduled"
            ? `Weekly backup '${backup.name}' expired from storage.`
            : `Backup '${backup.name}' expired from storage.`,
        metadata: { reason: "storage_lifecycle_expiration" },
      });
    });
  }
}

export async function syncBackupsFromS3(prefix?: string): Promise<void> {
  const scanStartedAt = new Date();
  const { prefix: configuredPrefix } = resolveBackupStorageConfig();
  const fullCatalogPrefix = `${configuredPrefix}/`;
  const requestedPrefix = prefix ?? fullCatalogPrefix;
  const isFullCatalogScan = requestedPrefix === fullCatalogPrefix;
  const seenStoragePaths = new Set<string>();
  const paginator = listBackups(requestedPrefix);

  for await (const page of paginator) {
    for (const object of page.Contents ?? []) {
      if (object.Key) seenStoragePaths.add(object.Key);
      await reconcileObject(object, configuredPrefix);
    }
  }

  // Only a complete prefix scan can prove an object is missing. Scoped syncs
  // intentionally skip lifecycle reconciliation.
  if (isFullCatalogScan) {
    await reconcileMissingObjects(configuredPrefix, seenStoragePaths, scanStartedAt);
  }
}
