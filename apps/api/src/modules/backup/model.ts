import { Elysia } from "elysia";
import { z } from "zod";

export const BACKUP_RESTORE_CONFIRMATION = "RESTORE_BACKUP_DISCARDS_NEWER_DATA" as const;
export const BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE =
  "Backup restore requires manual recovery before this server can start" as const;

export function backupRestoreRecoveryRequired(statusMessage: string | null | undefined): boolean {
  return statusMessage === BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE;
}

export const createBackupDto = z
  .object({
    name: z.string().min(1).max(100).optional(),
  })
  .strict()
  .default({});

export const restoreBackupDto = z
  .object({
    confirmation: z.literal(BACKUP_RESTORE_CONFIRMATION),
  })
  .strict();

export type BackupCreateInput = z.infer<typeof createBackupDto>;
export type BackupRestoreInput = z.infer<typeof restoreBackupDto>;

type BackupRecord = {
  id: string;
  serverId: string;
  name: string;
  sizeBytes: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "deleted";
  source: "manual" | "scheduled";
  activeOperation: "create" | "restore" | "delete" | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
};

export function toPublicBackup(backup: BackupRecord) {
  return {
    id: backup.id,
    serverId: backup.serverId,
    name: backup.name,
    sizeBytes: backup.sizeBytes,
    status: backup.status,
    source: backup.source,
    activeOperation: backup.activeOperation,
    createdAt: backup.createdAt,
    completedAt: backup.completedAt,
    expiresAt: backup.expiresAt,
  };
}

export const BackupModel = new Elysia({ name: "backup.model" }).model({
  "backup.create": createBackupDto,
  "backup.restore": restoreBackupDto,
});
