import type { PaidBillingPlan } from "./config";

export type EntitlementState = "active" | "grace" | "starter";

export type SubscriptionProjection = {
  plan: PaidBillingPlan;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerProductId: string;
  status: string;
  entitlementState: EntitlementState;
  cancelAtNextBillingDate: boolean;
  nextBillingDate: Date | null;
  graceUntil: Date | null;
  occurredAt: Date;
  eventId: string;
};

export type ProjectionDecision =
  | { outcome: "duplicate" | "stale" | "invalid_binding"; projection: null }
  | { outcome: "applied"; projection: SubscriptionProjection };

export type ProjectableBillingEvent = {
  eventId: string;
  occurredAt: Date;
  plan: PaidBillingPlan;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerProductId: string;
  status: string;
  cancelAtNextBillingDate: boolean;
  nextBillingDate: Date | null;
};

export type ProjectionContext = {
  alreadyProcessed: boolean;
  bindingValid: boolean;
  prior: SubscriptionProjection | null;
  now?: Date;
  gracePeriodMs?: number;
};

const ACTIVE_STATUSES = new Set(["active", "renewed"]);
const GRACE_STATUSES = new Set(["on_hold", "paused", "failed"]);
const STARTER_STATUSES = new Set(["cancelled", "expired"]);

function entitlementFor(
  event: ProjectableBillingEvent,
  now: Date,
  gracePeriodMs: number,
): Pick<SubscriptionProjection, "entitlementState" | "graceUntil"> {
  const normalized = event.status.toLowerCase();
  if (ACTIVE_STATUSES.has(normalized)) {
    return { entitlementState: "active", graceUntil: null };
  }

  if (
    normalized === "cancelled" &&
    event.cancelAtNextBillingDate &&
    event.nextBillingDate &&
    event.nextBillingDate > now
  ) {
    return { entitlementState: "active", graceUntil: null };
  }

  if (GRACE_STATUSES.has(normalized)) {
    const proposed = new Date(event.occurredAt.getTime() + gracePeriodMs);
    const graceUntil =
      event.nextBillingDate && event.nextBillingDate < proposed ? event.nextBillingDate : proposed;
    if (graceUntil > now) return { entitlementState: "grace", graceUntil };
  }

  if (STARTER_STATUSES.has(normalized) || normalized === "pending") {
    return { entitlementState: "starter", graceUntil: null };
  }

  // Unknown provider states never grant paid capacity.
  return { entitlementState: "starter", graceUntil: null };
}

/**
 * Deterministic, order-independent entitlement projection. An event at the
 * exact same provider timestamp is ordered by its unique webhook id so replay
 * converges even when deliveries are concurrent.
 */
export function decideSubscriptionProjection(
  event: ProjectableBillingEvent,
  context: ProjectionContext,
): ProjectionDecision {
  if (context.alreadyProcessed) return { outcome: "duplicate", projection: null };
  if (!context.bindingValid) return { outcome: "invalid_binding", projection: null };

  if (context.prior) {
    const delta = event.occurredAt.getTime() - context.prior.occurredAt.getTime();
    if (delta < 0 || (delta === 0 && event.eventId <= context.prior.eventId)) {
      return { outcome: "stale", projection: null };
    }
    if (
      context.prior.providerSubscriptionId !== event.providerSubscriptionId &&
      context.prior.providerCustomerId !== event.providerCustomerId
    ) {
      return { outcome: "invalid_binding", projection: null };
    }
  }

  const { entitlementState, graceUntil } = entitlementFor(
    event,
    context.now ?? new Date(),
    context.gracePeriodMs ?? 7 * 24 * 60 * 60 * 1_000,
  );
  return {
    outcome: "applied",
    projection: {
      ...event,
      entitlementState,
      graceUntil,
    },
  };
}

export function effectivePlan(projection: SubscriptionProjection | null, now = new Date()) {
  if (!projection) return "starter" as const;
  if (projection.entitlementState === "active") return projection.plan;
  if (
    projection.entitlementState === "grace" &&
    projection.graceUntil &&
    projection.graceUntil > now
  ) {
    return projection.plan;
  }
  return "starter" as const;
}
