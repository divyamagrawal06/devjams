CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"queue_status" text DEFAULT 'waiting' NOT NULL,
	"queue_sequence" bigserial NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"candidate_pod" text,
	"snapshot_id" text,
	"from_version" text,
	"to_version" text NOT NULL,
	"approved_content_digest" text NOT NULL,
	"initiated_by" text NOT NULL,
	"namespace" text,
	"live_deployment" text,
	"live_service" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "deployments_state_check" CHECK ("state" IN ('queued', 'building', 'staging', 'presync', 'freezing', 'verifying', 'cutover', 'draining', 'idle', 'aborted', 'failed')),
	CONSTRAINT "deployments_queue_status_check" CHECK ("queue_status" IN ('waiting', 'running', 'complete')),
	CONSTRAINT "deployments_approved_digest_sha256_check" CHECK ("approved_content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "deployment_state_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_headroom_reservations" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_rule_heads" (
	"server_id" text PRIMARY KEY NOT NULL,
	"current_version" text,
	"current_digest" text,
	"previous_version" text,
	"previous_digest" text,
	"current_deployment_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_rule_heads_current_digest_check" CHECK ("current_digest" IS NULL OR "current_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "server_rule_heads_previous_digest_check" CHECK ("previous_digest" IS NULL OR "previous_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "velocity_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"from_route" text NOT NULL,
	"to_route" text NOT NULL,
	"message" text NOT NULL,
	"source_players" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ack" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "velocity_transfers_status_check" CHECK ("status" IN ('pending', 'acked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment_state_events" ADD CONSTRAINT "deployment_state_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment_headroom_reservations" ADD CONSTRAINT "deployment_headroom_reservations_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment_headroom_reservations" ADD CONSTRAINT "deployment_headroom_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployment_headroom_reservations" ADD CONSTRAINT "deployment_headroom_reservations_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "server_rule_heads" ADD CONSTRAINT "server_rule_heads_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "server_rule_heads" ADD CONSTRAINT "server_rule_heads_current_deployment_id_deployments_id_fk" FOREIGN KEY ("current_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "velocity_transfers" ADD CONSTRAINT "velocity_transfers_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "deployments_server_started_idx" ON "deployments" USING btree ("server_id", "started_at");
--> statement-breakpoint
CREATE INDEX "deployments_user_started_idx" ON "deployments" USING btree ("user_id", "started_at");
--> statement-breakpoint
CREATE INDEX "deployments_queue_claim_idx" ON "deployments" USING btree ("queue_status", "lease_expires_at", "queue_sequence");
--> statement-breakpoint
CREATE INDEX "deployment_state_events_deployment_idx" ON "deployment_state_events" USING btree ("deployment_id", "id");
--> statement-breakpoint
CREATE INDEX "deployment_headroom_user_idx" ON "deployment_headroom_reservations" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "velocity_transfers_pending_idx" ON "velocity_transfers" USING btree ("status", "expires_at", "created_at");
