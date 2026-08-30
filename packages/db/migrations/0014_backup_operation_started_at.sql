ALTER TABLE "backups" ADD COLUMN "active_operation_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "backups" AS "backup"
SET "active_operation_started_at" = COALESCE(
  CASE
    WHEN "backup"."active_operation" = 'restore' THEN (
      SELECT "log"."created_at"
      FROM "backup_logs" AS "log"
      WHERE "log"."backup_id" = "backup"."id"
        AND "log"."event_type" = 'restore_started'
      ORDER BY "log"."created_at" DESC, "log"."id" DESC
      LIMIT 1
    )
    WHEN "backup"."active_operation" = 'create' THEN "backup"."created_at"
    ELSE NULL
  END,
  NOW()
)
WHERE "backup"."active_operation" IS NOT NULL;
