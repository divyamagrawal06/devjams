import { describe, expect, test } from "bun:test";

import {
  backupIsBusy,
  backupStatusLabel,
  backupStatusTone,
  formatBytes,
  formatUtcDateTime,
  serverCanRestoreBackup,
  weeklyScheduleLabel,
} from "./backups";

describe("backup presentation helpers", () => {
  test("formats byte sizes without noisy precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
  });

  test("describes active operations before the stored status", () => {
    expect(backupStatusLabel({ activeOperation: "restore", status: "in_progress" })).toBe(
      "Restoring",
    );
    expect(backupStatusLabel({ activeOperation: null, status: "completed" })).toBe("Ready");
    expect(backupStatusTone({ activeOperation: null, status: "failed" })).toBe("bad");
    expect(backupIsBusy({ activeOperation: "delete", status: "completed" })).toBe(true);
    expect(backupIsBusy({ status: "completed" })).toBe(false);
  });

  test("formats the weekly policy and timestamps in its declared timezone", () => {
    expect(weeklyScheduleLabel({ dayOfWeek: 0, hour: 3, minute: 5, timezone: "UTC" })).toBe(
      "Sunday at 03:05 UTC",
    );
    expect(formatUtcDateTime("2026-08-30T03:05:00.000Z")).toContain("UTC");
    expect(formatUtcDateTime(null)).toBe("Not yet");
  });

  test("allows a failed restore to retry without allowing the server to start", () => {
    expect(
      serverCanRestoreBackup({
        currentState: "failed",
        statusMessage: "Backup restore requires manual recovery before this server can start",
      }),
    ).toBe(true);
    expect(
      serverCanRestoreBackup({ currentState: "failed", statusMessage: "Provisioning failed" }),
    ).toBe(false);
  });
});
