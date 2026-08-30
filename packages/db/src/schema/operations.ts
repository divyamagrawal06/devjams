import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { deployments } from "./deployments";
import { ruleSetVersions } from "./rules";
import { gameServers } from "./servers";

const sha256Check = (column: { name: string }) =>
  sql.raw(`"${column.name}" ~ '^sha256:[0-9a-f]{64}$'`);

/**
 * One operator-visible chain from an immutable draft through a human verdict
 * and, on approval, the deployment it started. Identity and reviewed bytes are
 * protected by a trigger in migration 0010; only review/receipt fields advance.
 */
export const changeEnvelopes = pgTable(
  "change_envelopes",
  {
    id: text("id").primaryKey().notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleVersionId: text("rule_version_id")
      .notNull()
      .references(() => ruleSetVersions.id, { onDelete: "restrict" }),
    ruleVersion: integer("rule_version").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    source: text("source").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    contentDigest: text("content_digest").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    runtimeDigest: text("runtime_digest").notNull(),
    runtimeMinecraftVersion: text("runtime_minecraft_version").notNull(),
    status: text("status").notNull().default("pending_review"),
    reviewedArtifactDigest: text("reviewed_artifact_digest"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    deploymentId: text("deployment_id").references(() => deployments.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("change_envelopes_rule_version_idx").on(table.ruleVersionId),
    uniqueIndex("change_envelopes_deployment_idx")
      .on(table.deploymentId)
      .where(sql`${table.deploymentId} IS NOT NULL`),
    index("change_envelopes_owner_status_idx").on(table.userId, table.status, table.createdAt),
    index("change_envelopes_server_created_idx").on(table.serverId, table.createdAt),
    check("change_envelopes_id_check", sql`${table.id} ~ '^chg_[0-9a-f]{32}$'`),
    check("change_envelopes_rule_version_positive_check", sql`${table.ruleVersion} > 0`),
    check(
      "change_envelopes_title_length_check",
      sql`char_length(${table.title}) BETWEEN 3 AND 120`,
    ),
    check(
      "change_envelopes_rationale_length_check",
      sql`char_length(${table.rationale}) BETWEEN 1 AND 2000`,
    ),
    check("change_envelopes_source_check", sql`${table.source} IN ('form', 'agent', 'director')`),
    check(
      "change_envelopes_status_check",
      sql`${table.status} IN ('pending_review', 'approved', 'rejected')`,
    ),
    check("change_envelopes_content_digest_check", sha256Check(table.contentDigest)),
    check("change_envelopes_artifact_digest_check", sha256Check(table.artifactDigest)),
    check("change_envelopes_runtime_digest_check", sha256Check(table.runtimeDigest)),
    check(
      "change_envelopes_reviewed_digest_check",
      sql`${table.reviewedArtifactDigest} IS NULL OR ${sha256Check(table.reviewedArtifactDigest)}`,
    ),
    check(
      "change_envelopes_review_shape_check",
      sql`(
        (${table.status} = 'pending_review' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.reviewedArtifactDigest} IS NULL AND ${table.rejectionReason} IS NULL AND ${table.deploymentId} IS NULL)
        OR
        (${table.status} = 'approved' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.reviewedArtifactDigest} = ${table.artifactDigest} AND ${table.rejectionReason} IS NULL AND ${table.deploymentId} IS NOT NULL)
        OR
        (${table.status} = 'rejected' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.reviewedArtifactDigest} IS NULL AND char_length(${table.rejectionReason}) BETWEEN 1 AND 1000 AND ${table.deploymentId} IS NULL)
      )`,
    ),
  ],
);

/** Durable replay source. IDs are globally increasing and therefore monotonic per server. */
export const controlPlaneEvents = pgTable(
  "control_plane_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("control_plane_events_server_id_idx").on(table.serverId, table.id),
    check(
      "control_plane_events_type_length_check",
      sql`char_length(${table.type}) BETWEEN 1 AND 64`,
    ),
  ],
);
