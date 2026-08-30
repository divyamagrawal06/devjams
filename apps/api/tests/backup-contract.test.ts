import { describe, expect, test } from "bun:test";

import {
  BACKUP_RESTORE_CONFIRMATION,
  BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
  backupRestoreRecoveryRequired,
  restoreBackupDto,
  toPublicBackup,
} from "../src/modules/backup/model";
import { backupDownloadFilename } from "../src/modules/backup/s3";

describe("backup public contract", () => {
  test("projects only console-safe backup fields", () => {
    const row = {
      id: "backup-id",
      serverId: "server-id",
      name: "Weekly backup",
      storagePath: "private/server-id/weekly/archive.tar.gz",
      sizeBytes: 1024,
      status: "completed" as const,
      source: "scheduled" as const,
      activeOperation: null,
      createdAt: new Date("2026-08-30T03:00:00.000Z"),
      completedAt: new Date("2026-08-30T03:01:00.000Z"),
      expiresAt: null,
    };

    const response = toPublicBackup(row);
    expect(response.source).toBe("scheduled");
    expect(response.activeOperation).toBeNull();
    expect("storagePath" in response).toBe(false);
  });

  test("requires the exact destructive-restore confirmation", () => {
    expect(restoreBackupDto.safeParse({ confirmation: BACKUP_RESTORE_CONFIRMATION }).success).toBe(
      true,
    );
    expect(restoreBackupDto.safeParse({ confirmation: "restore" }).success).toBe(false);
    expect(
      restoreBackupDto.safeParse({ confirmDataLoss: BACKUP_RESTORE_CONFIRMATION }).success,
    ).toBe(false);
  });

  test("keeps unresolved restore recovery as a durable start blocker", () => {
    expect(backupRestoreRecoveryRequired(BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE)).toBe(true);
    expect(backupRestoreRecoveryRequired("Backup restore failed")).toBe(false);

    // Stopping a failed server changes only its lifecycle state. The durable
    // recovery sentinel must still classify the next restore as a recovery
    // retry, including when that retry cannot dispatch a Kubernetes Job.
    const stoppedAfterFailedRestore = {
      currentState: "stopped" as const,
      statusMessage: BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
    };
    const retryingRecovery = backupRestoreRecoveryRequired(stoppedAfterFailedRestore.statusMessage);
    const definitelyNotStarted = true;
    const statusAfterDispatchFailure =
      definitelyNotStarted && !retryingRecovery ? null : BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE;

    expect(retryingRecovery).toBe(true);
    expect(statusAfterDispatchFailure).toBe(BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE);
    expect(backupRestoreRecoveryRequired(statusAfterDispatchFailure)).toBe(true);
  });

  test("sanitizes user-provided names before Content-Disposition", () => {
    expect(backupDownloadFilename('../../Realm "one"\r\nX-Evil: yes')).toBe(
      "Realm-one-X-Evil-yes.tar.gz",
    );
    expect(backupDownloadFilename("existing.tar.gz")).toBe("existing.tar.gz");
  });
});
