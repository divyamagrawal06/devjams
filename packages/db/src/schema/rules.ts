import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { gameTypeEnum } from "./enums";
import { gameServers } from "./servers";

export const serverRules = pgTable(
  "server_rules",
  {
    id: text("id").primaryKey(),

    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description"),
    gameType: gameTypeEnum("game_type").notNull(),

    jsonUrl: text("json_url").notNull(),

    version: text("version").notNull().default("1.0"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("server_rules_created_by_idx").on(table.createdBy)],
);

export const serverRuleAssignments = pgTable(
  "server_rule_assignments",
  {
    id: text("id").primaryKey(),

    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    ruleId: text("rule_id")
      .notNull()
      .references(() => serverRules.id, { onDelete: "cascade" }),

    isActive: boolean("is_active").notNull().default(true),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("server_rule_assignments_idx").on(table.serverId, table.ruleId)],
);

const optionalSha256 = (column: { name: string }) =>
  sql.raw(`"${column.name}" ~ '^sha256:[0-9a-f]{64}$'`);

/** Immutable, human-reviewable document provenance. Raw prompts are never stored. */
export const ruleSetVersions = pgTable(
  "rule_set_versions",
  {
    id: text("id").primaryKey().notNull(),
    ruleSetId: text("rule_set_id")
      .notNull()
      .references(() => serverRules.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    jsonUrl: text("json_url").notNull(),
    contentDigest: text("content_digest").notNull(),
    source: text("source").notNull(),
    provenanceRef: text("provenance_ref"),
    provenanceDigest: text("provenance_digest"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rule_set_versions_rule_version_idx").on(table.ruleSetId, table.version),
    uniqueIndex("rule_set_versions_rule_content_idx").on(table.ruleSetId, table.contentDigest),
    check("rule_set_versions_version_positive_check", sql`${table.version} > 0`),
    check("rule_set_versions_source_check", sql`${table.source} IN ('form', 'agent', 'director')`),
    check("rule_set_versions_content_digest_check", optionalSha256(table.contentDigest)),
    check(
      "rule_set_versions_provenance_digest_check",
      sql`${table.provenanceDigest} IS NULL OR ${optionalSha256(table.provenanceDigest)}`,
    ),
    index("rule_set_versions_created_by_idx").on(table.createdBy, table.createdAt),
  ],
);

/** The exact deployable bytes produced from one immutable rule version. */
export const ruleArtifacts = pgTable(
  "rule_artifacts",
  {
    id: text("id").primaryKey().notNull(),
    ruleVersionId: text("rule_version_id")
      .notNull()
      .references(() => ruleSetVersions.id, { onDelete: "restrict" }),
    artifactUrl: text("artifact_url").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    runtimeDigest: text("runtime_digest").notNull(),
    runtimeMinecraftVersion: text("runtime_minecraft_version").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rule_artifacts_rule_version_idx").on(table.ruleVersionId),
    index("rule_artifacts_digest_idx").on(table.artifactDigest),
    check("rule_artifacts_digest_check", optionalSha256(table.artifactDigest)),
    check("rule_artifacts_runtime_digest_check", optionalSha256(table.runtimeDigest)),
    check("rule_artifacts_size_positive_check", sql`${table.sizeBytes} > 0`),
  ],
);
