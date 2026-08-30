import { sql } from "drizzle-orm";
import {
  boolean,
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
import { planEnum } from "./enums";
import { gameServers } from "./servers";

/**
 * An owner-supplied request key makes checkout creation safe to retry. A
 * provider timeout is recorded as `uncertain`; the same key is then held for
 * reconciliation instead of silently opening a second paid checkout.
 */
export const billingCheckoutSessions = pgTable(
  "billing_checkout_sessions",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plan: planEnum("plan").notNull(),
    requestKey: text("request_key").notNull(),
    state: text("state").notNull().default("creating"),
    providerSessionId: text("provider_session_id"),
    checkoutUrl: text("checkout_url"),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_checkout_user_request_idx").on(table.userId, table.requestKey),
    uniqueIndex("billing_checkout_provider_session_idx")
      .on(table.providerSessionId)
      .where(sql`${table.providerSessionId} IS NOT NULL`),
    index("billing_checkout_user_created_idx").on(table.userId, table.createdAt),
    check("billing_checkout_id_check", sql`${table.id} ~ '^bcs_[0-9a-f]{32}$'`),
    check("billing_checkout_paid_plan_check", sql`${table.plan} IN ('standard', 'pro')`),
    check(
      "billing_checkout_request_key_check",
      sql`char_length(${table.requestKey}) BETWEEN 8 AND 120`,
    ),
    check(
      "billing_checkout_state_check",
      sql`${table.state} IN ('creating', 'created', 'uncertain', 'failed')`,
    ),
    check(
      "billing_checkout_created_shape_check",
      sql`(${table.state} <> 'created') OR (${table.providerSessionId} IS NOT NULL AND ${table.checkoutUrl} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)`,
    ),
  ],
);

/** One webhook-derived entitlement projection per owner. */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    userId: text("user_id")
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    providerProductId: text("provider_product_id").notNull(),
    plan: planEnum("plan").notNull(),
    status: text("status").notNull(),
    entitlementState: text("entitlement_state").notNull(),
    cancelAtNextBillingDate: boolean("cancel_at_next_billing_date").notNull().default(false),
    nextBillingDate: timestamp("next_billing_date", { withTimezone: true }),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    projectionOccurredAt: timestamp("projection_occurred_at", { withTimezone: true }).notNull(),
    lastEventId: text("last_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_subscription_provider_idx").on(table.providerSubscriptionId),
    uniqueIndex("billing_subscription_customer_idx").on(table.providerCustomerId),
    check("billing_subscription_paid_plan_check", sql`${table.plan} IN ('standard', 'pro')`),
    check(
      "billing_subscription_entitlement_check",
      sql`${table.entitlementState} IN ('active', 'grace', 'starter')`,
    ),
    check(
      "billing_subscription_grace_shape_check",
      sql`(${table.entitlementState} = 'grace' AND ${table.graceUntil} IS NOT NULL) OR (${table.entitlementState} <> 'grace')`,
    ),
  ],
);

/**
 * Privacy-minimised deduplication ledger. The signed provider payload is
 * reduced to a digest and processing outcome; raw billing/customer data is not
 * retained here.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    providerSubscriptionId: text("provider_subscription_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("billing_webhook_subscription_idx").on(table.providerSubscriptionId, table.occurredAt),
    check("billing_webhook_digest_check", sql`${table.payloadDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check(
      "billing_webhook_outcome_check",
      sql`${table.outcome} IN ('applied', 'duplicate', 'stale', 'ignored', 'invalid_binding')`,
    ),
  ],
);

export const operatorReceipts = pgTable(
  "operator_receipts",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull().default("accepted"),
    observedState: text("observed_state"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_receipt_owner_request_idx").on(table.userId, table.requestKey),
    index("operator_receipt_server_created_idx").on(table.serverId, table.acceptedAt),
    check("operator_receipt_id_check", sql`${table.id} ~ '^orc_[0-9a-f]{32}$'`),
    check(
      "operator_receipt_request_key_check",
      sql`char_length(${table.requestKey}) BETWEEN 8 AND 120`,
    ),
    check("operator_receipt_action_check", sql`${table.action} IN ('start', 'stop', 'restart')`),
    check(
      "operator_receipt_status_check",
      sql`${table.status} IN ('accepted', 'completed', 'refused', 'failed')`,
    ),
    check(
      "operator_receipt_complete_shape_check",
      sql`(${table.status} = 'accepted' AND ${table.completedAt} IS NULL) OR (${table.status} <> 'accepted' AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull().default("scheduled"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("maintenance_owner_starts_idx").on(table.userId, table.startsAt),
    index("maintenance_server_starts_idx").on(table.serverId, table.startsAt),
    check("maintenance_id_check", sql`${table.id} ~ '^mnt_[0-9a-f]{32}$'`),
    check("maintenance_duration_check", sql`${table.durationMinutes} BETWEEN 15 AND 480`),
    check("maintenance_action_check", sql`${table.action} IN ('restart', 'operator_work')`),
    check(
      "maintenance_status_check",
      sql`${table.status} IN ('scheduled', 'cancelled', 'completed')`,
    ),
    check("maintenance_reason_check", sql`char_length(${table.reason}) BETWEEN 3 AND 500`),
  ],
);

/** Preferences only. No external delivery connector is implied by this row. */
export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deploymentEvents: boolean("deployment_events").notNull().default(true),
  backupEvents: boolean("backup_events").notNull().default(true),
  billingEvents: boolean("billing_events").notNull().default(true),
  maintenanceEvents: boolean("maintenance_events").notNull().default(true),
  timezone: text("timezone").notNull().default("UTC"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
