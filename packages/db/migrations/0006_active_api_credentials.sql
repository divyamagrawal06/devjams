CREATE TABLE "machine_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_tokens_hash_sha256_check" CHECK ("token_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "machine_tokens_id_check" CHECK ("id" ~ '^mtk_[0-9a-f]{32}$'),
	CONSTRAINT "machine_tokens_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "machine_tokens" ADD CONSTRAINT "machine_tokens_id_unique" UNIQUE("id");
--> statement-breakpoint
CREATE TABLE "operation_approvals" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"issued_to" text NOT NULL,
	"issued_by" text NOT NULL,
	"operation" text NOT NULL,
	"subject" text NOT NULL,
	"content_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_approvals_hash_sha256_check" CHECK ("token_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "operation_approvals_digest_sha256_check" CHECK ("content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "operation_approvals_operation_length_check" CHECK (char_length("operation") BETWEEN 1 AND 64),
	CONSTRAINT "operation_approvals_subject_length_check" CHECK (char_length("subject") BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE "machine_tokens" ADD CONSTRAINT "machine_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operation_approvals" ADD CONSTRAINT "operation_approvals_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "machine_tokens_user_id_idx" ON "machine_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "machine_tokens_expires_at_idx" ON "machine_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "operation_approvals_issued_to_idx" ON "operation_approvals" USING btree ("issued_to");
--> statement-breakpoint
CREATE INDEX "operation_approvals_expires_at_idx" ON "operation_approvals" USING btree ("expires_at");
