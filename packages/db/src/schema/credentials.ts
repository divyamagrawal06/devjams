import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { users } from "./auth";

const sha256Check = (column: { name: string }) =>
  sql.raw(`"${column.name}" ~ '^sha256:[0-9a-f]{64}$'`);

/**
 * Long-lived API credentials. Only the SHA-256 digest is retained, so a
 * database read cannot recover a bearer credential.
 */
export const machineTokens = pgTable(
  "machine_tokens",
  {
    tokenHash: text("token_hash").primaryKey().notNull(),
    id: text("id").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("machine_tokens_hash_sha256_check", sha256Check(table.tokenHash)),
    check("machine_tokens_id_check", sql`${table.id} ~ '^mtk_[0-9a-f]{32}$'`),
    check("machine_tokens_name_length_check", sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    index("machine_tokens_user_id_idx").on(table.userId),
    index("machine_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Short-lived, single-use grants for live operations. The operation, subject,
 * principal and canonical content digest are all checked during the same
 * conditional update that marks a grant consumed.
 */
export const operationApprovals = pgTable(
  "operation_approvals",
  {
    tokenHash: text("token_hash").primaryKey().notNull(),
    // A principal is either a human user id or an opaque machine-token id.
    // Mint authorization proves ownership before this value is persisted, so
    // it intentionally cannot be a foreign key to only one principal table.
    issuedTo: text("issued_to").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    subject: text("subject").notNull(),
    contentDigest: text("content_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operation_approvals_hash_sha256_check", sha256Check(table.tokenHash)),
    check("operation_approvals_digest_sha256_check", sha256Check(table.contentDigest)),
    check(
      "operation_approvals_operation_length_check",
      sql`char_length(${table.operation}) BETWEEN 1 AND 64`,
    ),
    check(
      "operation_approvals_subject_length_check",
      sql`char_length(${table.subject}) BETWEEN 1 AND 256`,
    ),
    index("operation_approvals_issued_to_idx").on(table.issuedTo),
    index("operation_approvals_expires_at_idx").on(table.expiresAt),
  ],
);
