import { backups } from "@repo/db";
import { and, eq, isNull } from "drizzle-orm";

export type BackupOperation = "create" | "restore" | "delete";
export type BackupStatus = "pending" | "in_progress" | "completed" | "failed" | "deleted";
export type LegacyRestoreEvent = "restore_started" | "restore_completed" | "restore_failed" | null;

export type BackupOperationAttempt = {
  activeOperation: BackupOperation | null;
  activeOperationAttemptId: string | null;
};

export function backupOperationAttemptMatches(
  current: BackupOperationAttempt,
  operation: BackupOperation,
  attemptId: string,
): boolean {
  return current.activeOperation === operation && current.activeOperationAttemptId === attemptId;
}

export function backupOperationAttemptClaim(operation: BackupOperation, attemptId: string) {
  return and(
    eq(backups.activeOperation, operation),
    eq(backups.activeOperationAttemptId, attemptId),
  )!;
}

export function inferLegacyBackupOperation(
  status: BackupStatus,
  latestRestoreEvent: LegacyRestoreEvent,
): BackupOperation | null {
  if (status === "pending") return "create";
  if (status !== "in_progress") return null;
  // This deliberately mirrors migration 0013. An in-progress record whose
  // newest restore event is terminal represents a later delete, while an
  // outstanding restore_started event represents the restore itself.
  return latestRestoreEvent === "restore_started" ? "restore" : "delete";
}

export function legacyBackupOperationAdoptionClaim(status: "pending" | "in_progress") {
  return and(
    eq(backups.status, status),
    isNull(backups.activeOperation),
    isNull(backups.activeOperationAttemptId),
    isNull(backups.activeOperationStartedAt),
  )!;
}

export function runtimeLegacyBackupAttemptId(adoptedAt: Date, entropy: string): string {
  return `legacy-runtime-${adoptedAt.getTime()}-${entropy}`;
}

export function runtimeLegacyBackupAttemptAdoptedAt(attemptId: string): Date | null {
  const match = /^legacy-runtime-(\d{13})-[0-9a-f-]+$/i.exec(attemptId);
  if (!match?.[1]) return null;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp)) return null;
  const adoptedAt = new Date(timestamp);
  return Number.isNaN(adoptedAt.getTime()) ? null : adoptedAt;
}

export function backupOperationTerminalStatus(
  operation: BackupOperation,
  operationCompleted: boolean,
  currentStatus: BackupStatus,
  completedAt: Date | null,
  storagePath: string,
): BackupStatus {
  if (operation === "create") return operationCompleted ? "completed" : "failed";
  if (operation === "restore") return "completed";
  if (operationCompleted) return "deleted";
  if (currentStatus !== "in_progress") return currentStatus;

  // Before active_operation existed, delete temporarily replaced the durable
  // backup status with in_progress. Recover an actionable base state instead
  // of leaving a failed migrated delete permanently wedged.
  return completedAt !== null || storagePath.trim().length > 0 ? "completed" : "failed";
}
