import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../packages/db/migrations/0013_backup_console_weekly.sql", import.meta.url),
  "utf8",
);

describe("backup migration compatibility", () => {
  test("deterministically selects one canonical record for duplicate storage paths", () => {
    const completed = migration.indexOf("WHEN 'completed' THEN 0");
    const pending = migration.indexOf("WHEN 'pending' THEN 1");
    const inProgress = migration.indexOf("WHEN 'in_progress' THEN 2");
    const failed = migration.indexOf("WHEN 'failed' THEN 3");
    const deleted = migration.indexOf("WHEN 'deleted' THEN 4");

    expect(completed).toBeGreaterThan(-1);
    expect(completed).toBeLessThan(pending);
    expect(pending).toBeLessThan(inProgress);
    expect(inProgress).toBeLessThan(failed);
    expect(failed).toBeLessThan(deleted);
    expect(migration).toContain('CASE WHEN "backup"."active_operation" IS NULL THEN 1 ELSE 0 END');
    expect(migration).toContain("WHEN 'restore' THEN 0");
    expect(migration).toContain('"backup"."completed_at" DESC NULLS LAST');
    expect(migration).toContain('"backup"."created_at" ASC');
    expect(migration).toContain('"backup"."id" ASC');
    expect(migration).toContain('"duplicate"."canonical_rank" > 1');
  });

  test("audits and clears only duplicates before adding the unique index", () => {
    const audit = migration.indexOf("duplicate_storage_path");
    const clearDuplicates = migration.indexOf("\"storage_path\" = ''");
    const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX "backups_storage_path_unique_idx"');

    expect(audit).toBeGreaterThan(-1);
    expect(migration).toContain("'canonicalBackupId'");
    expect(migration).toContain("'migration', '0013_backup_console_weekly'");
    expect(migration).toContain(
      'WHEN "backup"."active_operation" IS NULL THEN \'deleted\'::"backup_status"',
    );
    expect(migration).toContain("'activeOperationPreserved'");
    expect(clearDuplicates).toBeGreaterThan(audit);
    expect(uniqueIndex).toBeGreaterThan(clearDuplicates);
  });
});
