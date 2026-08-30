-- Closed rollups are the only durable world-telemetry record. There is no raw
-- event table by design: chat content is never accepted, and player names are
-- discarded after cardinality/session aggregation.
CREATE TABLE "world_events_rollup" (
  "server_id" text NOT NULL REFERENCES "game_servers"("id") ON DELETE CASCADE,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "metrics" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "world_events_rollup_pk" PRIMARY KEY ("server_id", "window_start", "window_end"),
  CONSTRAINT "world_events_rollup_window_check" CHECK ("window_end" > "window_start")
);
CREATE INDEX "world_events_rollup_server_end_idx"
  ON "world_events_rollup" ("server_id", "window_end");

-- Once a closed window is written it is evidence, not mutable cache. A retry
-- may insert the same primary key and be treated idempotently by the store, but
-- no caller may rewrite the retained aggregate in place.
CREATE OR REPLACE FUNCTION "world_events_rollup_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'closed world telemetry rollups are immutable';
END;
$$;
CREATE TRIGGER "world_events_rollup_immutable_trigger"
BEFORE UPDATE ON "world_events_rollup"
FOR EACH ROW EXECUTE FUNCTION "world_events_rollup_immutable"();

-- Agent draft rate limiting is durable across API replicas and restarts. It
-- intentionally retains neither the prompt nor model output.
CREATE TABLE "agent_draft_attempts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL REFERENCES "game_servers"("id") ON DELETE CASCADE,
  "principal_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_draft_attempts_principal_length_check"
    CHECK (char_length("principal_id") BETWEEN 1 AND 128)
);
CREATE INDEX "agent_draft_attempts_scope_idx"
  ON "agent_draft_attempts" ("server_id", "principal_id", "created_at");
