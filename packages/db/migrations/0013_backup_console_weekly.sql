CREATE TYPE "public"."backup_operation" AS ENUM('create', 'restore', 'delete');--> statement-breakpoint
CREATE TYPE "public"."backup_source" AS ENUM('manual', 'scheduled');--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "source" "backup_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "active_operation" "backup_operation";--> statement-breakpoint
UPDATE "backups" AS "backup"
SET "active_operation" = CASE
  WHEN "backup"."status" = 'pending' THEN 'create'::"backup_operation"
  WHEN (
    SELECT "log"."event_type"
    FROM "backup_logs" AS "log"
    WHERE "log"."backup_id" = "backup"."id"
      AND "log"."event_type" IN ('restore_started', 'restore_completed', 'restore_failed')
    ORDER BY "log"."created_at" DESC, "log"."id" DESC
    LIMIT 1
  ) = 'restore_started' THEN 'restore'::"backup_operation"
  ELSE 'delete'::"backup_operation"
END
WHERE "backup"."status" IN ('pending', 'in_progress');--> statement-breakpoint
WITH "ranked_storage_paths" AS (
  SELECT
    "backup"."id",
    "backup"."storage_path",
    ROW_NUMBER() OVER (
      PARTITION BY "backup"."storage_path"
      ORDER BY
        CASE WHEN "backup"."active_operation" IS NULL THEN 1 ELSE 0 END,
        CASE "backup"."active_operation"
          WHEN 'restore' THEN 0
          WHEN 'delete' THEN 1
          WHEN 'create' THEN 2
          ELSE 3
        END,
        CASE "backup"."status"
          WHEN 'completed' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'deleted' THEN 4
        END,
        "backup"."completed_at" DESC NULLS LAST,
        "backup"."created_at" ASC,
        "backup"."id" ASC
    ) AS "canonical_rank"
  FROM "backups" AS "backup"
  WHERE "backup"."storage_path" <> ''
),
"duplicate_storage_paths" AS (
  SELECT
    "duplicate"."id",
    "duplicate"."storage_path",
    "canonical"."id" AS "canonical_backup_id"
  FROM "ranked_storage_paths" AS "duplicate"
  INNER JOIN "ranked_storage_paths" AS "canonical"
    ON "canonical"."storage_path" = "duplicate"."storage_path"
    AND "canonical"."canonical_rank" = 1
  WHERE "duplicate"."canonical_rank" > 1
)
INSERT INTO "backup_logs" (
  "id",
  "backup_id",
  "server_id",
  "level",
  "event_type",
  "message",
  "metadata"
)
SELECT
  'migration-0013-storage-duplicate-' || md5(
    "duplicate"."id" || ':' || "duplicate"."canonical_backup_id"
  ),
  "backup"."id",
  "backup"."server_id",
  'warn'::"log_level",
  'backup_deleted'::"backup_event_type",
  'Duplicate backup record consolidated during storage-path migration.',
  jsonb_build_object(
    'reason', 'duplicate_storage_path',
    'migration', '0013_backup_console_weekly',
    'storagePath', "duplicate"."storage_path",
    'canonicalBackupId', "duplicate"."canonical_backup_id",
    'activeOperationPreserved', "backup"."active_operation" IS NOT NULL
  )
FROM "duplicate_storage_paths" AS "duplicate"
INNER JOIN "backups" AS "backup" ON "backup"."id" = "duplicate"."id"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
WITH "ranked_storage_paths" AS (
  SELECT
    "backup"."id",
    ROW_NUMBER() OVER (
      PARTITION BY "backup"."storage_path"
      ORDER BY
        CASE WHEN "backup"."active_operation" IS NULL THEN 1 ELSE 0 END,
        CASE "backup"."active_operation"
          WHEN 'restore' THEN 0
          WHEN 'delete' THEN 1
          WHEN 'create' THEN 2
          ELSE 3
        END,
        CASE "backup"."status"
          WHEN 'completed' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'deleted' THEN 4
        END,
        "backup"."completed_at" DESC NULLS LAST,
        "backup"."created_at" ASC,
        "backup"."id" ASC
    ) AS "canonical_rank"
  FROM "backups" AS "backup"
  WHERE "backup"."storage_path" <> ''
)
UPDATE "backups" AS "backup"
SET
  "status" = CASE
    WHEN "backup"."active_operation" IS NULL THEN 'deleted'::"backup_status"
    ELSE "backup"."status"
  END,
  "storage_path" = ''
FROM "ranked_storage_paths" AS "ranked"
WHERE "backup"."id" = "ranked"."id"
  AND "ranked"."canonical_rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "backups_storage_path_unique_idx" ON "backups" USING btree ("storage_path") WHERE "backups"."storage_path" <> '';
