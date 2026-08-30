ALTER TABLE "deployments" ADD COLUMN "live_pvc" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "live_proxy_target" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "candidate_service" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "candidate_pvc" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_players" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "lobby_players" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_player_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "presync_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "saves_disabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "candidate_healthy" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "route_switched" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "abort_requested_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "velocity_route_rosters" (
	"route" text PRIMARY KEY NOT NULL,
	"target_host" text NOT NULL,
	"target_port" integer NOT NULL,
	"players" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "velocity_route_rosters_observed_idx" ON "velocity_route_rosters" USING btree ("observed_at");
