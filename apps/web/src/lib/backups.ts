import type { Backup, BackupSchedule, LiveServer } from "./api";

export const BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE =
  "Backup restore requires manual recovery before this server can start";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatUtcDateTime(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

export function weeklyScheduleLabel(
  schedule: Pick<BackupSchedule, "dayOfWeek" | "hour" | "minute" | "timezone">,
): string {
  const normalizedDay = ((Math.trunc(schedule.dayOfWeek) % 7) + 7) % 7;
  const hour = Math.min(23, Math.max(0, Math.trunc(schedule.hour)));
  const minute = Math.min(59, Math.max(0, Math.trunc(schedule.minute)));
  return `${DAYS[normalizedDay]} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${schedule.timezone}`;
}

export function backupStatusLabel(backup: Pick<Backup, "activeOperation" | "status">): string {
  if (backup.activeOperation === "create") return "Creating";
  if (backup.activeOperation === "restore") return "Restoring";
  if (backup.activeOperation === "delete") return "Deleting";

  switch (backup.status) {
    case "pending":
      return "Queued";
    case "in_progress":
      return "Working";
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

export function backupStatusTone(
  backup: Pick<Backup, "activeOperation" | "status">,
): "bad" | "good" | "working" {
  if (backup.status === "failed") return "bad";
  if (backup.status === "completed" && !backup.activeOperation) return "good";
  return "working";
}

export function backupIsBusy(backup: Pick<Backup, "activeOperation" | "status">): boolean {
  return (
    backup.activeOperation != null || backup.status === "pending" || backup.status === "in_progress"
  );
}

export function serverCanRestoreBackup(
  server: Pick<LiveServer, "currentState" | "statusMessage">,
): boolean {
  return (
    server.currentState === "ready" ||
    server.currentState === "stopped" ||
    (server.currentState === "failed" &&
      server.statusMessage === BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE)
  );
}
