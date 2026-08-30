export type BackupStorageConfig = {
  bucket: string;
  region: string;
  prefix: string;
};

export type BackupSource = "manual" | "scheduled";

export type BackupScheduleConfig = {
  enabled: boolean;
  frequency: "weekly";
  timezone: "UTC";
  dayOfWeek: number;
  hour: number;
  minute: number;
  retentionCount: number;
};

export type BackupSyncConfig = {
  enabled: boolean;
  intervalMs: number;
};

export type BackupScheduleHealth = "healthy" | "pending" | "degraded" | "disabled";

type BackupEnvironment = Record<string, string | undefined> &
  Partial<
    Record<
      "AWS_REGION" | "BACKUP_BUCKET" | "S3_BUCKET" | "BACKUP_S3_PREFIX" | "S3_PREFIX",
      string | undefined
    >
  >;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = nonEmpty(value);
  if (!normalized) return defaultValue;
  if (!/^-?\d+$/.test(normalized)) throw new Error(`${name} must be an integer`);

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function resolveBackupStorageConfig(
  environment: BackupEnvironment = process.env,
): BackupStorageConfig {
  const bucket = nonEmpty(environment.BACKUP_BUCKET) ?? nonEmpty(environment.S3_BUCKET);
  const region = nonEmpty(environment.AWS_REGION);
  const configuredPrefix =
    nonEmpty(environment.BACKUP_S3_PREFIX) ?? nonEmpty(environment.S3_PREFIX) ?? "infra-team";
  const prefix = normalizePrefix(configuredPrefix);

  if (!bucket) {
    throw new Error("Missing BACKUP_BUCKET or S3_BUCKET");
  }
  if (!region) {
    throw new Error("Missing AWS_REGION");
  }
  if (!prefix) {
    throw new Error("Backup S3 prefix must not be empty");
  }

  return { bucket, region, prefix };
}

export function resolveBackupScheduleConfig(
  environment: Record<string, string | undefined> = process.env,
): BackupScheduleConfig {
  return {
    enabled: parseBoolean("BACKUP_SCHEDULE_ENABLED", environment.BACKUP_SCHEDULE_ENABLED, true),
    frequency: "weekly",
    timezone: "UTC",
    dayOfWeek: parseInteger(
      "BACKUP_SCHEDULE_DAY_OF_WEEK",
      environment.BACKUP_SCHEDULE_DAY_OF_WEEK,
      0,
      0,
      6,
    ),
    hour: parseInteger("BACKUP_SCHEDULE_HOUR_UTC", environment.BACKUP_SCHEDULE_HOUR_UTC, 3, 0, 23),
    minute: parseInteger(
      "BACKUP_SCHEDULE_MINUTE_UTC",
      environment.BACKUP_SCHEDULE_MINUTE_UTC,
      0,
      0,
      59,
    ),
    retentionCount: parseInteger(
      "BACKUP_RETENTION_COUNT",
      environment.BACKUP_RETENTION_COUNT,
      3,
      1,
      52,
    ),
  };
}

export function nextWeeklyBackupRun(
  schedule: BackupScheduleConfig,
  now: Date = new Date(),
): Date | null {
  if (!schedule.enabled) return null;

  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(schedule.hour, schedule.minute, 0, 0);
  next.setUTCDate(next.getUTCDate() + ((schedule.dayOfWeek - next.getUTCDay() + 7) % 7));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

export function backupScheduleHealth(
  enabled: boolean,
  lastAttemptAt: Date | null,
  lastServerRecoveryPointAt: Date | null,
  now: Date = new Date(),
  completionWindowMs = 7 * 60 * 60 * 1_000,
): BackupScheduleHealth {
  if (!enabled) return "disabled";
  if (!lastAttemptAt) return "pending";
  if (lastServerRecoveryPointAt && lastServerRecoveryPointAt.getTime() >= lastAttemptAt.getTime()) {
    return "healthy";
  }
  return now.getTime() - lastAttemptAt.getTime() <= completionWindowMs ? "pending" : "degraded";
}

export function resolveBackupSyncConfig(
  environment: Record<string, string | undefined> = process.env,
): BackupSyncConfig {
  return {
    enabled: parseBoolean("BACKUP_SYNC_ENABLED", environment.BACKUP_SYNC_ENABLED, false),
    intervalMs: parseInteger(
      "BACKUP_SYNC_INTERVAL_MS",
      environment.BACKUP_SYNC_INTERVAL_MS,
      5 * 60 * 1000,
      10_000,
      24 * 60 * 60 * 1000,
    ),
  };
}

export function resolveBackupDownloadTtlSeconds(
  environment: Record<string, string | undefined> = process.env,
): number {
  return parseInteger(
    "BACKUP_DOWNLOAD_URL_TTL_SECONDS",
    environment.BACKUP_DOWNLOAD_URL_TTL_SECONDS,
    5 * 60,
    60,
    15 * 60,
  );
}

export function parseBackupStorageKey(
  storageKey: string,
  configuredPrefix: string,
): { serverId: string; filename: string; source: BackupSource } | null {
  const prefix = normalizePrefix(configuredPrefix);
  const prefixWithSeparator = `${prefix}/`;
  if (!prefix || !storageKey.startsWith(prefixWithSeparator)) return null;

  const relativeParts = storageKey.slice(prefixWithSeparator.length).split("/");
  if (relativeParts.length === 2 && relativeParts[0] && relativeParts[1]) {
    return { serverId: relativeParts[0], filename: relativeParts[1], source: "manual" };
  }

  // The weekly directory is the authoritative source marker. The first shape
  // is emitted by the cluster scheduler; the second remains accepted for
  // compatibility with an early pre-release layout.
  if (
    relativeParts.length === 3 &&
    relativeParts[0] &&
    relativeParts[1] === "weekly" &&
    relativeParts[2]
  ) {
    return { serverId: relativeParts[0], filename: relativeParts[2], source: "scheduled" };
  }
  if (
    relativeParts.length === 3 &&
    relativeParts[0] === "weekly" &&
    relativeParts[1] &&
    relativeParts[2]
  ) {
    return { serverId: relativeParts[1], filename: relativeParts[2], source: "scheduled" };
  }

  return null;
}
