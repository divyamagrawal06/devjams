CREATE TABLE "billing_checkout_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "plan" "plan" NOT NULL,
  "request_key" text NOT NULL,
  "state" text DEFAULT 'creating' NOT NULL,
  "provider_session_id" text,
  "checkout_url" text,
  "error_code" text,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_checkout_id_check" CHECK ("id" ~ '^bcs_[0-9a-f]{32}$'),
  CONSTRAINT "billing_checkout_paid_plan_check" CHECK ("plan" IN ('standard', 'pro')),
  CONSTRAINT "billing_checkout_request_key_check" CHECK (char_length("request_key") BETWEEN 8 AND 120),
  CONSTRAINT "billing_checkout_state_check" CHECK ("state" IN ('creating', 'created', 'uncertain', 'failed')),
  CONSTRAINT "billing_checkout_created_shape_check" CHECK (("state" <> 'created') OR ("provider_session_id" IS NOT NULL AND "checkout_url" IS NOT NULL AND "expires_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "billing_checkout_user_request_idx" ON "billing_checkout_sessions" ("user_id", "request_key");
CREATE UNIQUE INDEX "billing_checkout_provider_session_idx" ON "billing_checkout_sessions" ("provider_session_id") WHERE "provider_session_id" IS NOT NULL;
CREATE INDEX "billing_checkout_user_created_idx" ON "billing_checkout_sessions" ("user_id", "created_at");

CREATE TABLE "billing_subscriptions" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_subscription_id" text NOT NULL,
  "provider_customer_id" text NOT NULL,
  "provider_product_id" text NOT NULL,
  "plan" "plan" NOT NULL,
  "status" text NOT NULL,
  "entitlement_state" text NOT NULL,
  "cancel_at_next_billing_date" boolean DEFAULT false NOT NULL,
  "next_billing_date" timestamp with time zone,
  "grace_until" timestamp with time zone,
  "projection_occurred_at" timestamp with time zone NOT NULL,
  "last_event_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscription_paid_plan_check" CHECK ("plan" IN ('standard', 'pro')),
  CONSTRAINT "billing_subscription_entitlement_check" CHECK ("entitlement_state" IN ('active', 'grace', 'starter')),
  CONSTRAINT "billing_subscription_grace_shape_check" CHECK (("entitlement_state" = 'grace' AND "grace_until" IS NOT NULL) OR ("entitlement_state" <> 'grace'))
);
CREATE UNIQUE INDEX "billing_subscription_provider_idx" ON "billing_subscriptions" ("provider_subscription_id");
CREATE UNIQUE INDEX "billing_subscription_customer_idx" ON "billing_subscriptions" ("provider_customer_id");

CREATE TABLE "billing_webhook_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "payload_digest" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "outcome" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "provider_subscription_id" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_webhook_digest_check" CHECK ("payload_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "billing_webhook_outcome_check" CHECK ("outcome" IN ('applied', 'duplicate', 'stale', 'ignored', 'invalid_binding'))
);
CREATE INDEX "billing_webhook_subscription_idx" ON "billing_webhook_events" ("provider_subscription_id", "occurred_at");

CREATE UNIQUE INDEX "game_servers_id_user_id_idx" ON "game_servers" ("id", "user_id");

CREATE TABLE "operator_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "game_servers"("id") ON DELETE CASCADE,
  "request_key" text NOT NULL,
  "action" text NOT NULL,
  "status" text DEFAULT 'accepted' NOT NULL,
  "observed_state" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operator_receipt_owner_server_fk" FOREIGN KEY ("server_id", "user_id") REFERENCES "game_servers"("id", "user_id") ON DELETE CASCADE,
  CONSTRAINT "operator_receipt_id_check" CHECK ("id" ~ '^orc_[0-9a-f]{32}$'),
  CONSTRAINT "operator_receipt_request_key_check" CHECK (char_length("request_key") BETWEEN 8 AND 120),
  CONSTRAINT "operator_receipt_action_check" CHECK ("action" IN ('start', 'stop', 'restart')),
  CONSTRAINT "operator_receipt_status_check" CHECK ("status" IN ('accepted', 'completed', 'refused', 'failed')),
  CONSTRAINT "operator_receipt_complete_shape_check" CHECK (("status" = 'accepted' AND "completed_at" IS NULL) OR ("status" <> 'accepted' AND "completed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "operator_receipt_owner_request_idx" ON "operator_receipts" ("user_id", "request_key");
CREATE INDEX "operator_receipt_server_created_idx" ON "operator_receipts" ("server_id", "accepted_at");

CREATE TABLE "maintenance_windows" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "game_servers"("id") ON DELETE CASCADE,
  "starts_at" timestamp with time zone NOT NULL,
  "duration_minutes" integer NOT NULL,
  "action" text NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_owner_server_fk" FOREIGN KEY ("server_id", "user_id") REFERENCES "game_servers"("id", "user_id") ON DELETE CASCADE,
  CONSTRAINT "maintenance_id_check" CHECK ("id" ~ '^mnt_[0-9a-f]{32}$'),
  CONSTRAINT "maintenance_duration_check" CHECK ("duration_minutes" BETWEEN 15 AND 480),
  CONSTRAINT "maintenance_action_check" CHECK ("action" IN ('restart', 'operator_work')),
  CONSTRAINT "maintenance_status_check" CHECK ("status" IN ('scheduled', 'cancelled', 'completed')),
  CONSTRAINT "maintenance_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 500)
);
CREATE INDEX "maintenance_owner_starts_idx" ON "maintenance_windows" ("user_id", "starts_at");
CREATE INDEX "maintenance_server_starts_idx" ON "maintenance_windows" ("server_id", "starts_at");

CREATE TABLE "notification_preferences" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "deployment_events" boolean DEFAULT true NOT NULL,
  "backup_events" boolean DEFAULT true NOT NULL,
  "billing_events" boolean DEFAULT true NOT NULL,
  "maintenance_events" boolean DEFAULT true NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Checkout identity and successful provider bindings are immutable. Recovery
-- may only advance state/error/expiry after the row has been created.
CREATE OR REPLACE FUNCTION "billing_checkout_protect_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."user_id" <> OLD."user_id"
    OR NEW."plan" <> OLD."plan"
    OR NEW."request_key" <> OLD."request_key"
    OR (OLD."provider_session_id" IS NOT NULL AND NEW."provider_session_id" IS DISTINCT FROM OLD."provider_session_id")
    OR (OLD."checkout_url" IS NOT NULL AND NEW."checkout_url" IS DISTINCT FROM OLD."checkout_url")
  THEN
    RAISE EXCEPTION 'billing checkout identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "billing_checkout_protect_identity_trigger"
BEFORE UPDATE ON "billing_checkout_sessions"
FOR EACH ROW EXECUTE FUNCTION "billing_checkout_protect_identity"();
