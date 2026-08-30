import { randomUUID } from "node:crypto";
import {
  billingCheckoutSessions,
  billingSubscriptions,
  billingWebhookEvents,
  userQuotas,
  users,
} from "@repo/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db";
import { QuotaService } from "../quota/quota.service";
import {
  type BillingConfig,
  type BillingPlan,
  type PaidBillingPlan,
  PLAN_LIMITS,
  planForProduct,
  quotaValuesForPlan,
  readBillingConfig,
} from "./config";
import {
  type CheckoutState,
  checkoutDisposition,
  subscriptionWebhookBindingValid,
  webhookBindingValid,
} from "./policy";
import {
  decideSubscriptionProjection,
  effectivePlan,
  type SubscriptionProjection,
} from "./projection";
import {
  type BillingProvider,
  DodoBillingProvider,
  ProviderDefinitiveError,
  ProviderUncertainError,
} from "./provider";
import { reconcileTimeBoundEntitlement } from "./reconciliation";
import type { VerifiedBillingEvent } from "./webhook";

export class BillingOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingOperationError";
  }
}

function checkoutId(): string {
  return `bcs_${randomUUID().replaceAll("-", "")}`;
}

function checkoutPublic(row: typeof billingCheckoutSessions.$inferSelect, reused: boolean) {
  if (row.state !== "created" || !row.checkoutUrl || !row.providerSessionId || !row.expiresAt) {
    throw new BillingOperationError(
      409,
      "checkout_reconciliation_required",
      "This checkout request has no safe result to reuse. Refresh billing before trying again with a new request.",
    );
  }
  return {
    checkout_url: row.checkoutUrl,
    session_id: row.providerSessionId,
    expires_at: row.expiresAt.toISOString(),
    reused,
  };
}

function rowProjection(row: typeof billingSubscriptions.$inferSelect): SubscriptionProjection {
  return {
    plan: row.plan as PaidBillingPlan,
    providerSubscriptionId: row.providerSubscriptionId,
    providerCustomerId: row.providerCustomerId,
    providerProductId: row.providerProductId,
    status: row.status,
    entitlementState: row.entitlementState as SubscriptionProjection["entitlementState"],
    cancelAtNextBillingDate: row.cancelAtNextBillingDate,
    nextBillingDate: row.nextBillingDate,
    graceUntil: row.graceUntil,
    occurredAt: row.projectionOccurredAt,
    eventId: row.lastEventId,
  };
}

function quotaMatchesPlan(quota: typeof userQuotas.$inferSelect, plan: BillingPlan): boolean {
  const expected = quotaValuesForPlan(plan);
  return (
    quota.plan === expected.plan &&
    quota.serversLimit === expected.serversLimit &&
    quota.ramLimitMb === expected.ramLimitMb &&
    quota.cpuLimit === expected.cpuLimit &&
    quota.storageLimitGb === expected.storageLimitGb &&
    quota.backupsLimit === expected.backupsLimit
  );
}

export type BillingProviderFactory = (config: BillingConfig) => BillingProvider;

export abstract class BillingService {
  static async summary(userId: string, now = new Date()) {
    await reconcileTimeBoundEntitlement(userId, now);
    const configState = readBillingConfig();
    const [quota] = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId));
    if (!quota) {
      throw new BillingOperationError(
        404,
        "quota_not_found",
        "No quota was found for this account.",
      );
    }
    const [[subscription], [latestCheckout]] = await Promise.all([
      db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)),
      db
        .select({
          id: billingCheckoutSessions.id,
          plan: billingCheckoutSessions.plan,
          state: billingCheckoutSessions.state,
          errorCode: billingCheckoutSessions.errorCode,
          updatedAt: billingCheckoutSessions.updatedAt,
        })
        .from(billingCheckoutSessions)
        .where(eq(billingCheckoutSessions.userId, userId))
        .orderBy(desc(billingCheckoutSessions.createdAt))
        .limit(1),
    ]);
    const usage = await QuotaService.getResourceUsage(userId);

    const plans = (["starter", "standard", "pro"] as const).map((plan) => ({
      plan,
      configured:
        plan === "starter" ||
        (configState.enabled && Boolean(configState.config.products[plan as PaidBillingPlan])),
      limits: {
        servers: PLAN_LIMITS[plan].servers,
        ram_mb: PLAN_LIMITS[plan].ramMb,
        cpu_cores: PLAN_LIMITS[plan].cpuCores,
        storage_gb: PLAN_LIMITS[plan].storageGb,
        backups: PLAN_LIMITS[plan].backups,
      },
    }));

    return {
      provider: "dodo_payments" as const,
      enabled: configState.enabled,
      configuration_state: configState.enabled ? "ready" : configState.reason,
      current_plan: quota.plan,
      entitlement_state: subscription?.entitlementState ?? "starter",
      grace_until: subscription?.graceUntil?.toISOString() ?? null,
      plans,
      subscription: subscription
        ? {
            plan: subscription.plan as PaidBillingPlan,
            status: subscription.status,
            cancel_at_next_billing_date: subscription.cancelAtNextBillingDate,
            next_billing_date: subscription.nextBillingDate?.toISOString() ?? null,
          }
        : null,
      can_manage_billing: configState.enabled && Boolean(subscription?.providerCustomerId),
      checkout_reconciliation: latestCheckout
        ? {
            id: latestCheckout.id,
            plan: latestCheckout.plan,
            state: latestCheckout.state,
            error_code: latestCheckout.errorCode,
            updated_at: latestCheckout.updatedAt.toISOString(),
          }
        : null,
      quota_reconciliation: {
        state: quotaMatchesPlan(quota, quota.plan) ? "in_sync" : "needs_reconciliation",
        over_quota: usage?.overQuota ?? false,
      },
    };
  }

  static async createCheckout(
    userId: string,
    plan: PaidBillingPlan,
    requestKey: string,
    providerFactory: BillingProviderFactory = (config) => new DodoBillingProvider(config),
  ) {
    const configState = readBillingConfig();
    if (!configState.enabled) {
      throw new BillingOperationError(
        503,
        "billing_not_configured",
        "Paid billing is unavailable. Starter quota remains unchanged.",
      );
    }

    const [account] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    if (!account) throw new BillingOperationError(404, "account_not_found", "Account not found.");

    const id = checkoutId();
    const row = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}:${requestKey}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(billingCheckoutSessions)
        .where(
          and(
            eq(billingCheckoutSessions.userId, userId),
            eq(billingCheckoutSessions.requestKey, requestKey),
          ),
        );
      if (existing) return existing;

      const [created] = await tx
        .insert(billingCheckoutSessions)
        .values({ id, userId, plan, requestKey, state: "creating" })
        .returning();
      if (!created) throw new Error("Checkout reservation failed");
      return created;
    });

    const disposition = checkoutDisposition(plan, { ...row, state: row.state as CheckoutState });
    if (disposition === "conflict") {
      throw new BillingOperationError(
        409,
        "request_key_conflict",
        "That checkout request key is already bound to another plan.",
      );
    }
    if (disposition === "reuse") return checkoutPublic(row, true);
    if (disposition === "expired") {
      await db
        .update(billingCheckoutSessions)
        .set({ state: "failed", errorCode: "checkout_expired", updatedAt: new Date() })
        .where(eq(billingCheckoutSessions.id, row.id));
      throw new BillingOperationError(
        410,
        "checkout_expired",
        "That checkout expired without changing quota. Start a new checkout when ready.",
      );
    }
    if (disposition === "definitive_failure") {
      throw new BillingOperationError(
        409,
        "checkout_refused",
        "That checkout request ended without changing quota. Start a new checkout when ready.",
      );
    }
    if (row.id !== id || row.state !== "creating") {
      throw new BillingOperationError(
        409,
        "checkout_reconciliation_required",
        "This checkout request is already being reconciled. Refresh billing before trying a new request.",
      );
    }

    try {
      const result = await providerFactory(configState.config).createCheckout({
        internalCheckoutId: id,
        userId,
        email: account.email,
        name: account.name,
        plan,
      });
      const [completed] = await db
        .update(billingCheckoutSessions)
        .set({
          state: "created",
          providerSessionId: result.sessionId,
          checkoutUrl: result.checkoutUrl,
          expiresAt: result.expiresAt,
          updatedAt: new Date(),
        })
        .where(
          and(eq(billingCheckoutSessions.id, id), eq(billingCheckoutSessions.state, "creating")),
        )
        .returning();
      if (!completed) {
        throw new BillingOperationError(
          409,
          "checkout_reconciliation_required",
          "Checkout completed but its local receipt needs reconciliation.",
        );
      }
      return checkoutPublic(completed, false);
    } catch (error) {
      if (error instanceof BillingOperationError) throw error;
      const uncertain =
        error instanceof ProviderUncertainError || !(error instanceof ProviderDefinitiveError);
      await db
        .update(billingCheckoutSessions)
        .set({
          state: uncertain ? "uncertain" : "failed",
          errorCode: uncertain ? "provider_outcome_unknown" : "provider_refused",
          updatedAt: new Date(),
        })
        .where(
          and(eq(billingCheckoutSessions.id, id), eq(billingCheckoutSessions.state, "creating")),
        );
      throw new BillingOperationError(
        uncertain ? 503 : 502,
        uncertain ? "checkout_reconciliation_required" : "checkout_refused",
        uncertain
          ? "The provider outcome is unknown. This request key will not create another checkout; refresh billing before retrying."
          : "The billing provider refused checkout. Your quota is unchanged.",
      );
    }
  }

  static async createPortal(
    userId: string,
    providerFactory: BillingProviderFactory = (config) => new DodoBillingProvider(config),
  ) {
    const configState = readBillingConfig();
    if (!configState.enabled) {
      throw new BillingOperationError(503, "billing_not_configured", "Billing is unavailable.");
    }
    const [subscription] = await db
      .select({ providerCustomerId: billingSubscriptions.providerCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId));
    if (!subscription) {
      throw new BillingOperationError(
        404,
        "billing_customer_not_found",
        "No billing customer is linked to this account.",
      );
    }
    try {
      return {
        portal_url: await providerFactory(configState.config).createPortal(
          subscription.providerCustomerId,
        ),
      };
    } catch {
      throw new BillingOperationError(
        503,
        "billing_portal_unavailable",
        "The billing portal could not be opened. Try again later.",
      );
    }
  }

  static async applyWebhook(config: BillingConfig, event: VerifiedBillingEvent) {
    return db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(billingWebhookEvents)
        .values({
          eventId: event.eventId,
          eventType: event.eventType,
          payloadDigest: event.payloadDigest,
          occurredAt: event.occurredAt,
          outcome: "ignored",
          providerSubscriptionId: event.providerSubscriptionId,
        })
        .onConflictDoNothing()
        .returning({ eventId: billingWebhookEvents.eventId });
      if (!claimed) return { outcome: "duplicate" as const };

      if (!event.eventType.startsWith("subscription.")) {
        return { outcome: "ignored" as const };
      }

      const mappedPlan = event.providerProductId
        ? planForProduct(event.providerProductId, config.products)
        : null;
      const hasProviderIdentity = Boolean(
        mappedPlan &&
          event.providerSubscriptionId &&
          event.providerCustomerId &&
          event.providerProductId &&
          event.status,
      );

      // Subscription/customer identifiers are provider-signed durable owner
      // bindings. They let portal plan changes project even when their retained
      // checkout metadata still names the originally purchased plan.
      const [subscriptionByProviderId] = hasProviderIdentity
        ? await tx
            .select()
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.providerSubscriptionId, event.providerSubscriptionId!))
            .limit(1)
        : [];
      const [subscriptionByCustomerId] = hasProviderIdentity
        ? await tx
            .select()
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.providerCustomerId, event.providerCustomerId!))
            .limit(1)
        : [];
      const boundOwnerIds = new Set(
        [subscriptionByProviderId?.userId, subscriptionByCustomerId?.userId].filter(
          (candidate): candidate is string => Boolean(candidate),
        ),
      );
      const [inferredBoundOwner] = boundOwnerIds;
      const suppliedOwnerConflicts = Boolean(
        event.userId && [...boundOwnerIds].some((boundOwner) => boundOwner !== event.userId),
      );
      const providerBindingsConflict = boundOwnerIds.size > 1;
      const resolvedUserId =
        suppliedOwnerConflicts || providerBindingsConflict
          ? null
          : (event.userId ?? inferredBoundOwner ?? null);

      // Events for one owner must project serially. A row-level lock is not
      // sufficient before that owner's first subscription row exists.
      if (hasProviderIdentity && resolvedUserId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`billing-subscription:${resolvedUserId}`}))`,
        );
      }

      const [priorRow] = resolvedUserId
        ? await tx
            .select()
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.userId, resolvedUserId))
            .for("update")
        : [];
      const hasCheckoutIdentity = Boolean(
        hasProviderIdentity && resolvedUserId && event.checkoutId && event.requestedPlan,
      );
      const [checkout] = hasCheckoutIdentity
        ? await tx
            .select()
            .from(billingCheckoutSessions)
            .where(
              and(
                eq(billingCheckoutSessions.id, event.checkoutId!),
                eq(billingCheckoutSessions.userId, resolvedUserId!),
                eq(billingCheckoutSessions.plan, event.requestedPlan!),
                inArray(billingCheckoutSessions.state, ["created", "creating", "uncertain"]),
              ),
            )
            .limit(1)
        : [];
      const checkoutBindingValid = webhookBindingValid({
        userId: resolvedUserId,
        requestedPlan: event.requestedPlan,
        mappedPlan,
        checkout: checkout
          ? {
              userId: checkout.userId,
              plan: checkout.plan,
              state: checkout.state as "creating" | "created" | "uncertain",
            }
          : null,
        conflictingUserId:
          [...boundOwnerIds].find((boundOwner) => boundOwner !== resolvedUserId) ?? null,
      });
      const durableSubscriptionBindingValid = subscriptionWebhookBindingValid({
        userId: resolvedUserId,
        suppliedUserId: event.userId,
        mappedPlan,
        providerSubscriptionId: event.providerSubscriptionId,
        providerCustomerId: event.providerCustomerId,
        subscription: priorRow
          ? {
              userId: priorRow.userId,
              providerSubscriptionId: priorRow.providerSubscriptionId,
              providerCustomerId: priorRow.providerCustomerId,
            }
          : null,
      });
      const bindingValid = checkoutBindingValid || durableSubscriptionBindingValid;
      const decision = decideSubscriptionProjection(
        {
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          plan: mappedPlan ?? "standard",
          providerSubscriptionId: event.providerSubscriptionId ?? "missing",
          providerCustomerId: event.providerCustomerId ?? "missing",
          providerProductId: event.providerProductId ?? "missing",
          status: event.status ?? "unknown",
          cancelAtNextBillingDate: event.cancelAtNextBillingDate,
          nextBillingDate: event.nextBillingDate,
        },
        {
          alreadyProcessed: false,
          bindingValid,
          prior: priorRow ? rowProjection(priorRow) : null,
        },
      );

      await tx
        .update(billingWebhookEvents)
        .set({
          outcome: decision.outcome,
          userId: bindingValid ? resolvedUserId : null,
          processedAt: new Date(),
        })
        .where(eq(billingWebhookEvents.eventId, event.eventId));
      if (decision.outcome !== "applied") return { outcome: decision.outcome };

      const projection = decision.projection;
      if (event.checkoutId) {
        await tx
          .update(billingCheckoutSessions)
          .set({
            state: sql`CASE WHEN ${billingCheckoutSessions.state} = 'creating' THEN 'uncertain' ELSE ${billingCheckoutSessions.state} END`,
            errorCode: sql`CASE WHEN ${billingCheckoutSessions.state} = 'creating' THEN 'reconciled_by_webhook' ELSE ${billingCheckoutSessions.errorCode} END`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(billingCheckoutSessions.id, event.checkoutId),
              eq(billingCheckoutSessions.userId, resolvedUserId!),
            ),
          );
      }
      await tx
        .insert(billingSubscriptions)
        .values({
          userId: resolvedUserId!,
          providerSubscriptionId: projection.providerSubscriptionId,
          providerCustomerId: projection.providerCustomerId,
          providerProductId: projection.providerProductId,
          plan: projection.plan,
          status: projection.status,
          entitlementState: projection.entitlementState,
          cancelAtNextBillingDate: projection.cancelAtNextBillingDate,
          nextBillingDate: projection.nextBillingDate,
          graceUntil: projection.graceUntil,
          projectionOccurredAt: projection.occurredAt,
          lastEventId: projection.eventId,
        })
        .onConflictDoUpdate({
          target: billingSubscriptions.userId,
          set: {
            providerSubscriptionId: projection.providerSubscriptionId,
            providerCustomerId: projection.providerCustomerId,
            providerProductId: projection.providerProductId,
            plan: projection.plan,
            status: projection.status,
            entitlementState: projection.entitlementState,
            cancelAtNextBillingDate: projection.cancelAtNextBillingDate,
            nextBillingDate: projection.nextBillingDate,
            graceUntil: projection.graceUntil,
            projectionOccurredAt: projection.occurredAt,
            lastEventId: projection.eventId,
            updatedAt: new Date(),
          },
        });

      const entitledPlan = effectivePlan(projection);
      await tx
        .insert(userQuotas)
        .values({ userId: resolvedUserId!, ...quotaValuesForPlan(entitledPlan) })
        .onConflictDoUpdate({
          target: userQuotas.userId,
          set: { ...quotaValuesForPlan(entitledPlan), updatedAt: new Date() },
        });
      return { outcome: "applied" as const, plan: entitledPlan };
    });
  }
}
