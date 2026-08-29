CREATE TABLE "rule_set_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_set_id" text NOT NULL,
	"version" integer NOT NULL,
	"json_url" text NOT NULL,
	"content_digest" text NOT NULL,
	"source" text NOT NULL,
	"provenance_ref" text,
	"provenance_digest" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_set_versions_version_positive_check" CHECK ("version" > 0),
	CONSTRAINT "rule_set_versions_source_check" CHECK ("source" IN ('form', 'agent', 'director')),
	CONSTRAINT "rule_set_versions_content_digest_check" CHECK ("content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "rule_set_versions_provenance_digest_check" CHECK ("provenance_digest" IS NULL OR "provenance_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "rule_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_version_id" text NOT NULL,
	"artifact_url" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"runtime_digest" text NOT NULL,
	"runtime_minecraft_version" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_artifacts_digest_check" CHECK ("artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "rule_artifacts_runtime_digest_check" CHECK ("runtime_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "rule_artifacts_size_positive_check" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_url" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_digest" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_runtime_version" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_artifact_digest_sha256_check" CHECK ("artifact_digest" IS NULL OR "artifact_digest" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "rule_set_versions" ADD CONSTRAINT "rule_set_versions_rule_set_id_server_rules_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."server_rules"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rule_set_versions" ADD CONSTRAINT "rule_set_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rule_artifacts" ADD CONSTRAINT "rule_artifacts_rule_version_id_rule_set_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."rule_set_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rule_set_versions_rule_version_idx" ON "rule_set_versions" USING btree ("rule_set_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "rule_set_versions_rule_content_idx" ON "rule_set_versions" USING btree ("rule_set_id", "content_digest");
--> statement-breakpoint
CREATE INDEX "rule_set_versions_created_by_idx" ON "rule_set_versions" USING btree ("created_by", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "rule_artifacts_rule_version_idx" ON "rule_artifacts" USING btree ("rule_version_id");
--> statement-breakpoint
CREATE INDEX "rule_artifacts_digest_idx" ON "rule_artifacts" USING btree ("artifact_digest");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION farlands_reject_immutable_rule_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rule_set_versions_append_only
BEFORE UPDATE OR DELETE ON "rule_set_versions"
FOR EACH ROW EXECUTE FUNCTION farlands_reject_immutable_rule_mutation();
--> statement-breakpoint
CREATE TRIGGER rule_artifacts_append_only
BEFORE UPDATE OR DELETE ON "rule_artifacts"
FOR EACH ROW EXECUTE FUNCTION farlands_reject_immutable_rule_mutation();
