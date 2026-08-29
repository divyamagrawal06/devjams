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
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { gameServers } from "./servers";

const sha256Check = (column: { name: string }) =>
  sql.raw(`"${column.name}" ~ '^sha256:[0-9a-f]{64}$'`);

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey().notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("queued"),
    queueStatus: text("queue_status").notNull().default("waiting"),
    queueSequence: bigserial("queue_sequence", { mode: "number" }).notNull(),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    candidatePod: text("candidate_pod"),
    snapshotId: text("snapshot_id"),
    fromVersion: text("from_version"),
    toVersion: text("to_version").notNull(),
    approvedContentDigest: text("approved_content_digest").notNull(),
    artifactUrl: text("artifact_url"),
    artifactDigest: text("artifact_digest"),
    artifactRuntimeVersion: text("artifact_runtime_version"),
    initiatedBy: text("initiated_by").notNull(),
    namespace: text("namespace"),
    liveDeployment: text("live_deployment"),
    liveService: text("live_service"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "deployments_state_check",
      sql`${table.state} IN ('queued', 'building', 'staging', 'presync', 'freezing', 'verifying', 'cutover', 'draining', 'idle', 'aborted', 'failed')`,
    ),
    check(
      "deployments_queue_status_check",
      sql`${table.queueStatus} IN ('waiting', 'running', 'complete')`,
    ),
    check("deployments_approved_digest_sha256_check", sha256Check(table.approvedContentDigest)),
    check(
      "deployments_artifact_digest_sha256_check",
      sql`${table.artifactDigest} IS NULL OR ${sha256Check(table.artifactDigest)}`,
    ),
    index("deployments_server_started_idx").on(table.serverId, table.startedAt),
    index("deployments_user_started_idx").on(table.userId, table.startedAt),
    index("deployments_queue_claim_idx").on(
      table.queueStatus,
      table.leaseExpiresAt,
      table.queueSequence,
    ),
  ],
);

export const deploymentStateEvents = pgTable(
  "deployment_state_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("deployment_state_events_deployment_idx").on(table.deploymentId, table.id)],
);

export const deploymentHeadroomReservations = pgTable(
  "deployment_headroom_reservations",
  {
    deploymentId: text("deployment_id")
      .primaryKey()
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("deployment_headroom_user_idx").on(table.userId)],
);

export const serverRuleHeads = pgTable(
  "server_rule_heads",
  {
    serverId: text("server_id")
      .primaryKey()
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    currentVersion: text("current_version"),
    currentDigest: text("current_digest"),
    previousVersion: text("previous_version"),
    previousDigest: text("previous_digest"),
    currentDeploymentId: text("current_deployment_id").references(() => deployments.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "server_rule_heads_current_digest_check",
      sql`${table.currentDigest} IS NULL OR ${sha256Check(table.currentDigest)}`,
    ),
    check(
      "server_rule_heads_previous_digest_check",
      sql`${table.previousDigest} IS NULL OR ${sha256Check(table.previousDigest)}`,
    ),
  ],
);

export const velocityTransfers = pgTable(
  "velocity_transfers",
  {
    id: text("id").primaryKey().notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    fromRoute: text("from_route").notNull(),
    toRoute: text("to_route").notNull(),
    message: text("message").notNull(),
    sourcePlayers: jsonb("source_players").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    ack: jsonb("ack").$type<{
      movedPlayers: string[];
      failures: Array<{ player: string; reason: string }>;
    }>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "velocity_transfers_status_check",
      sql`${table.status} IN ('pending', 'acked', 'expired')`,
    ),
    index("velocity_transfers_pending_idx").on(table.status, table.expiresAt, table.createdAt),
  ],
);
