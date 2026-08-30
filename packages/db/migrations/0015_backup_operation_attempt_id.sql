ALTER TABLE "backups" ADD COLUMN "active_operation_attempt_id" text;--> statement-breakpoint
UPDATE "backups" AS "backup"
SET "active_operation_attempt_id" = 'legacy-' || md5(
  "backup"."id" || ':' ||
  COALESCE("backup"."active_operation"::text, '') || ':' ||
  clock_timestamp()::text || ':' ||
  random()::text
)
WHERE "backup"."active_operation" IS NOT NULL;--> statement-breakpoint
UPDATE "backups" AS "backup"
SET "status" = COALESCE(
  (
    SELECT CASE "log"."event_type"
      WHEN 'backup_completed' THEN 'completed'::"backup_status"
      WHEN 'backup_failed' THEN 'failed'::"backup_status"
    END
    FROM "backup_logs" AS "log"
    WHERE "log"."backup_id" = "backup"."id"
      AND "log"."event_type" IN ('backup_completed', 'backup_failed')
    ORDER BY "log"."created_at" DESC, "log"."id" DESC
    LIMIT 1
  ),
  CASE
    WHEN "backup"."completed_at" IS NOT NULL OR "backup"."storage_path" <> ''
      THEN 'completed'::"backup_status"
    ELSE 'failed'::"backup_status"
  END
)
WHERE "backup"."active_operation" = 'delete'
  AND "backup"."status" = 'in_progress';--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_active_operation_attempt_check" CHECK (
  (
    "active_operation" IS NULL
    AND "active_operation_attempt_id" IS NULL
    AND "active_operation_started_at" IS NULL
  )
  OR
  (
    "active_operation" IS NOT NULL
    AND "active_operation_attempt_id" IS NOT NULL
    AND "active_operation_started_at" IS NOT NULL
  )
);
