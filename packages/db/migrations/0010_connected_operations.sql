CREATE TABLE "change_envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rule_version_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"source" text NOT NULL,
	"document" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"runtime_digest" text NOT NULL,
	"runtime_minecraft_version" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_artifact_digest" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"deployment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_envelopes_id_check" CHECK ("id" ~ '^chg_[0-9a-f]{32}$'),
	CONSTRAINT "change_envelopes_rule_version_positive_check" CHECK ("rule_version" > 0),
	CONSTRAINT "change_envelopes_title_length_check" CHECK (char_length("title") BETWEEN 3 AND 120),
	CONSTRAINT "change_envelopes_rationale_length_check" CHECK (char_length("rationale") BETWEEN 1 AND 2000),
	CONSTRAINT "change_envelopes_source_check" CHECK ("source" IN ('form', 'agent', 'director')),
	CONSTRAINT "change_envelopes_status_check" CHECK ("status" IN ('pending_review', 'approved', 'rejected')),
	CONSTRAINT "change_envelopes_content_digest_check" CHECK ("content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "change_envelopes_artifact_digest_check" CHECK ("artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "change_envelopes_runtime_digest_check" CHECK ("runtime_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "change_envelopes_reviewed_digest_check" CHECK ("reviewed_artifact_digest" IS NULL OR "reviewed_artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "change_envelopes_review_shape_check" CHECK (
		("status" = 'pending_review' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL AND "reviewed_artifact_digest" IS NULL AND "rejection_reason" IS NULL AND "deployment_id" IS NULL)
		OR
		("status" = 'approved' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "reviewed_artifact_digest" = "artifact_digest" AND "rejection_reason" IS NULL AND "deployment_id" IS NOT NULL)
		OR
		("status" = 'rejected' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "reviewed_artifact_digest" IS NULL AND char_length("rejection_reason") BETWEEN 1 AND 1000 AND "deployment_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "control_plane_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_plane_events_type_length_check" CHECK (char_length("type") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "change_envelopes" ADD CONSTRAINT "change_envelopes_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_envelopes" ADD CONSTRAINT "change_envelopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_envelopes" ADD CONSTRAINT "change_envelopes_rule_version_id_rule_set_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."rule_set_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_envelopes" ADD CONSTRAINT "change_envelopes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_envelopes" ADD CONSTRAINT "change_envelopes_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "control_plane_events" ADD CONSTRAINT "control_plane_events_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "change_envelopes_rule_version_idx" ON "change_envelopes" USING btree ("rule_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "change_envelopes_deployment_idx" ON "change_envelopes" USING btree ("deployment_id") WHERE "deployment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "change_envelopes_owner_status_idx" ON "change_envelopes" USING btree ("user_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "change_envelopes_server_created_idx" ON "change_envelopes" USING btree ("server_id", "created_at");
--> statement-breakpoint
CREATE INDEX "control_plane_events_server_id_idx" ON "control_plane_events" USING btree ("server_id", "id");
--> statement-breakpoint
INSERT INTO "control_plane_events" ("server_id", "type", "data", "created_at")
SELECT
	d."server_id",
	'deployment_state',
	jsonb_build_object(
		'deployment_id', e."deployment_id",
		'state', e."state",
		'detail', e."detail",
		'queue_position', NULL
	),
	e."created_at"
FROM "deployment_state_events" e
INNER JOIN "deployments" d ON d."id" = e."deployment_id"
ORDER BY e."id";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION farlands_protect_change_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF ROW(
		NEW.server_id, NEW.user_id, NEW.rule_version_id, NEW.rule_version,
		NEW.title, NEW.rationale, NEW.source, NEW.document,
		NEW.content_digest, NEW.artifact_digest, NEW.runtime_digest,
		NEW.runtime_minecraft_version, NEW.created_at
	) IS DISTINCT FROM ROW(
		OLD.server_id, OLD.user_id, OLD.rule_version_id, OLD.rule_version,
		OLD.title, OLD.rationale, OLD.source, OLD.document,
		OLD.content_digest, OLD.artifact_digest, OLD.runtime_digest,
		OLD.runtime_minecraft_version, OLD.created_at
	) THEN
		RAISE EXCEPTION 'change envelope review identity is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_envelopes_protect_identity
BEFORE UPDATE ON "change_envelopes"
FOR EACH ROW EXECUTE FUNCTION farlands_protect_change_identity();
