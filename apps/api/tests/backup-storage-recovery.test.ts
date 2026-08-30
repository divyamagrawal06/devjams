import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type * as k8s from "@kubernetes/client-node";

import { legacyCreateJobStoragePath } from "../src/modules/backup/k8s-job";
import { lookupMissingCreateBackupObject } from "../src/modules/backup/recovery";
import { backupObjectHeadIsMissing, backupObjectMetadataFromHead } from "../src/modules/backup/s3";

const backupServiceSource = readFileSync(
  new URL("../src/modules/backup/service.ts", import.meta.url),
  "utf8",
);
const backupSyncSource = readFileSync(
  new URL("../src/modules/backup/sync.ts", import.meta.url),
  "utf8",
);
const backupJobSource = readFileSync(
  new URL("../src/modules/backup/k8s-job.ts", import.meta.url),
  "utf8",
);

describe("missing backup Job storage recovery", () => {
  test("extracts a validated storage key from a terminal legacy create Job", () => {
    const storagePath = "backups/server-id/server-id-20260830T030000Z.tar.gz";
    const job = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "upload-backup",
                env: [{ name: "STORAGE_PATH", value: storagePath }],
              },
            ],
          },
        },
      },
    } as k8s.V1Job;

    expect(legacyCreateJobStoragePath(job, "server-id", "legacy-attempt", "backups")).toBe(
      storagePath,
    );
    expect(legacyCreateJobStoragePath(job, "server-id", "new-attempt", "backups")).toBeNull();

    job.spec!.template.spec!.containers[0]!.env![0]!.value =
      "backups/other-server/other-server-20260830T030000Z.tar.gz";
    expect(legacyCreateJobStoragePath(job, "server-id", "legacy-attempt", "backups")).toBeNull();
  });

  test("recovers a missing create only from its exact non-empty object key", async () => {
    const completedAt = new Date("2026-08-30T04:05:06.000Z");
    const lookup = mock(async (storagePath: string) => {
      expect(storagePath).toBe("backups/server-id/server-id-20260830T030000Z.tar.gz");
      return { sizeBytes: 4_096, completedAt };
    });

    await expect(
      lookupMissingCreateBackupObject(
        "create",
        "backups/server-id/server-id-20260830T030000Z.tar.gz",
        lookup,
      ),
    ).resolves.toEqual({ sizeBytes: 4_096, completedAt });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("does not inspect storage for non-create operations or an empty legacy path", async () => {
    const lookup = mock(async () => ({ sizeBytes: 1, completedAt: new Date() }));

    await expect(
      lookupMissingCreateBackupObject("restore", "exact-key", lookup),
    ).resolves.toBeNull();
    await expect(
      lookupMissingCreateBackupObject("delete", "exact-key", lookup),
    ).resolves.toBeNull();
    await expect(lookupMissingCreateBackupObject("create", "  ", lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  test("propagates S3 uncertainty instead of treating it as a missing archive", async () => {
    const uncertain = Object.assign(new Error("S3 unavailable"), {
      name: "SlowDown",
      $metadata: { httpStatusCode: 503 },
    });
    const lookup = mock(async () => {
      throw uncertain;
    });

    await expect(
      lookupMissingCreateBackupObject("create", "backups/server-id/archive.tar.gz", lookup),
    ).rejects.toBe(uncertain);
    expect(backupObjectHeadIsMissing(uncertain)).toBe(false);
    expect(backupObjectHeadIsMissing({ $metadata: { httpStatusCode: 403 } })).toBe(false);
  });

  test("accepts only a positive-size object with a valid S3 timestamp", () => {
    const completedAt = new Date("2026-08-30T04:05:06.000Z");
    expect(
      backupObjectMetadataFromHead({ ContentLength: 4_096, LastModified: completedAt }),
    ).toEqual({ sizeBytes: 4_096, completedAt });
    expect(
      backupObjectMetadataFromHead({ ContentLength: 0, LastModified: completedAt }),
    ).toBeNull();
    expect(backupObjectMetadataFromHead({ ContentLength: 4_096 })).toBeNull();
    expect(backupObjectHeadIsMissing({ name: "NoSuchKey" })).toBe(true);
    expect(backupObjectHeadIsMissing({ $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  test("checks exact storage before a missing create is finalized and retains uncertainty", () => {
    const lookup = backupServiceSource.indexOf("await lookupMissingCreateBackupObject(");
    const terminalDecision = backupServiceSource.indexOf(
      "const jobState = terminalCreateStoragePathMissing",
    );

    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(terminalDecision);
    expect(backupServiceSource).toContain("Could not verify exact storage key");
    expect(backupServiceSource).toContain(
      "await releaseMissingJobFence();\n        return backup;",
    );
    expect(backupServiceSource).toContain('reconciledFrom: "s3_exact_key"');
  });

  test("backfills an empty terminal legacy path before completion and deduplicates conflicts", () => {
    const reconcileStart = backupServiceSource.indexOf(
      "private static async reconcileBackupOperation",
    );
    const pathClaim = backupServiceSource.indexOf(
      "await claimLegacyCreateStoragePath(",
      reconcileStart,
    );
    const terminalUpdate = backupServiceSource.indexOf(
      "const [terminalBackup] = await db",
      reconcileStart,
    );

    expect(pathClaim).toBeGreaterThan(reconcileStart);
    expect(pathClaim).toBeLessThan(terminalUpdate);
    expect(backupServiceSource).toContain('postgresErrorCode(error) !== "23505"');
    expect(backupServiceSource).toContain("canonicalStorageBackupId");
    expect(backupServiceSource).toContain('reason: "duplicate_storage_path"');
    expect(backupServiceSource).toContain('reason: "legacy_job_storage_path_missing_or_invalid"');
    expect(backupJobSource).toContain("legacyCreateJobStoragePath(");
    expect(backupJobSource).toContain("...(storagePath ? { storagePath } : {})");
  });

  test("heals exact-key rows failed by an older reconciler", () => {
    expect(backupSyncSource).toContain('existing.status === "failed"');
    expect(backupSyncSource).toContain("eq(backups.storagePath, object.Key!)");
    expect(backupSyncSource).toContain('reason: "failed_catalog_row_with_archive"');
  });
});
