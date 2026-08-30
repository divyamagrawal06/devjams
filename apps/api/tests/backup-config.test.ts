import { describe, expect, test } from "bun:test";

import {
  backupScheduleHealth,
  nextWeeklyBackupRun,
  parseBackupStorageKey,
  resolveBackupDownloadTtlSeconds,
  resolveBackupScheduleConfig,
  resolveBackupStorageConfig,
  resolveBackupSyncConfig,
} from "../src/modules/backup/config";

describe("backup storage configuration", () => {
  test("prefers backup-specific bucket and prefix variables", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
        S3_BUCKET: "shared-bucket",
        BACKUP_S3_PREFIX: "/backup-prefix/",
        S3_PREFIX: "shared-prefix",
      }),
    ).toEqual({
      bucket: "backup-bucket",
      region: "ap-south-1",
      prefix: "backup-prefix",
    });
  });

  test("falls back to S3_BUCKET and S3_PREFIX", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "",
        S3_BUCKET: "shared-bucket",
        BACKUP_S3_PREFIX: "",
        S3_PREFIX: "shared-prefix/",
      }),
    ).toEqual({
      bucket: "shared-bucket",
      region: "ap-south-1",
      prefix: "shared-prefix",
    });
  });

  test("uses the default prefix when neither prefix variable is set", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
      }).prefix,
    ).toBe("infra-team");
  });

  test("rejects missing bucket, region, and empty normalized prefix", () => {
    expect(() => resolveBackupStorageConfig({ AWS_REGION: "ap-south-1" })).toThrow(
      "Missing BACKUP_BUCKET or S3_BUCKET",
    );
    expect(() => resolveBackupStorageConfig({ BACKUP_BUCKET: "backup-bucket" })).toThrow(
      "Missing AWS_REGION",
    );
    expect(() =>
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
        BACKUP_S3_PREFIX: "/",
      }),
    ).toThrow("Backup S3 prefix must not be empty");
  });
});

describe("backup storage key parsing", () => {
  test("parses keys relative to a nested configured prefix", () => {
    expect(parseBackupStorageKey("team/backups/server-id/archive.tar.gz", "team/backups")).toEqual({
      serverId: "server-id",
      filename: "archive.tar.gz",
      source: "manual",
    });
  });

  test("marks the scheduler's weekly directory as scheduled", () => {
    expect(
      parseBackupStorageKey(
        "team/backups/server-id/weekly/server-id-weekly-20260830T030000Z.tar.gz",
        "team/backups",
      ),
    ).toEqual({
      serverId: "server-id",
      filename: "server-id-weekly-20260830T030000Z.tar.gz",
      source: "scheduled",
    });
  });

  test("accepts the pre-release weekly directory layout", () => {
    expect(
      parseBackupStorageKey(
        "team/backups/weekly/server-id/server-id-weekly-20260830T030000Z.tar.gz",
        "team/backups",
      ),
    ).toEqual({
      serverId: "server-id",
      filename: "server-id-weekly-20260830T030000Z.tar.gz",
      source: "scheduled",
    });
  });

  test("rejects unrelated and malformed keys", () => {
    expect(parseBackupStorageKey("other/server-id/archive.tar.gz", "team/backups")).toBeNull();
    expect(
      parseBackupStorageKey("team/backups/extra/server-id/archive.tar.gz", "team/backups"),
    ).toBeNull();
  });
});

describe("weekly backup policy", () => {
  test("defaults to the cluster's Sunday 03:00 UTC policy", () => {
    const schedule = resolveBackupScheduleConfig({});
    expect(schedule).toEqual({
      enabled: true,
      frequency: "weekly",
      timezone: "UTC",
      dayOfWeek: 0,
      hour: 3,
      minute: 0,
      retentionCount: 3,
    });
    expect(nextWeeklyBackupRun(schedule, new Date("2026-08-30T02:59:00.000Z"))?.toISOString()).toBe(
      "2026-08-30T03:00:00.000Z",
    );
    expect(nextWeeklyBackupRun(schedule, new Date("2026-08-30T03:00:00.000Z"))?.toISOString()).toBe(
      "2026-09-06T03:00:00.000Z",
    );
  });

  test("returns no next run when policy readback is disabled", () => {
    const schedule = resolveBackupScheduleConfig({ BACKUP_SCHEDULE_ENABLED: "false" });
    expect(nextWeeklyBackupRun(schedule, new Date("2026-08-30T00:00:00.000Z"))).toBeNull();
  });

  test("validates policy ranges", () => {
    expect(() => resolveBackupScheduleConfig({ BACKUP_SCHEDULE_DAY_OF_WEEK: "7" })).toThrow(
      "BACKUP_SCHEDULE_DAY_OF_WEEK must be between 0 and 6",
    );
    expect(() => resolveBackupScheduleConfig({ BACKUP_RETENTION_COUNT: "0" })).toThrow(
      "BACKUP_RETENTION_COUNT must be between 1 and 52",
    );
  });

  test("evaluates health from this server's recovery point", () => {
    const attempt = new Date("2026-08-30T03:00:00.000Z");

    expect(backupScheduleHealth(false, attempt, null, new Date("2026-08-30T12:00:00Z"))).toBe(
      "disabled",
    );
    expect(backupScheduleHealth(true, null, null, new Date("2026-08-30T12:00:00Z"))).toBe(
      "pending",
    );
    expect(backupScheduleHealth(true, attempt, null, new Date("2026-08-30T09:59:59.999Z"))).toBe(
      "pending",
    );
    expect(backupScheduleHealth(true, attempt, null, new Date("2026-08-30T10:00:00.001Z"))).toBe(
      "degraded",
    );
    expect(
      backupScheduleHealth(
        true,
        attempt,
        new Date("2026-08-30T03:30:00.000Z"),
        new Date("2026-08-30T12:00:00.000Z"),
      ),
    ).toBe("healthy");
  });
});

describe("backup background settings", () => {
  test("keeps catalog sync opt-in and download links short-lived", () => {
    expect(resolveBackupSyncConfig({})).toEqual({ enabled: false, intervalMs: 300_000 });
    expect(resolveBackupSyncConfig({ BACKUP_SYNC_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveBackupDownloadTtlSeconds({})).toBe(300);
    expect(() =>
      resolveBackupDownloadTtlSeconds({ BACKUP_DOWNLOAD_URL_TTL_SECONDS: "3600" }),
    ).toThrow("BACKUP_DOWNLOAD_URL_TTL_SECONDS must be between 60 and 900");
  });
});
