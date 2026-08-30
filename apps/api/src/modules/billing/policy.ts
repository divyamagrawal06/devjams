import type { PaidBillingPlan } from "./config";

export type CheckoutState = "creating" | "created" | "uncertain" | "failed";

export function checkoutDisposition(
  requestedPlan: PaidBillingPlan,
  row: { plan: string; state: CheckoutState; expiresAt: Date | null } | null,
  now = new Date(),
): "create" | "reuse" | "expired" | "definitive_failure" | "reconcile" | "conflict" {
  if (!row) return "create";
  if (row.plan !== requestedPlan) return "conflict";
  if (row.state === "created") {
    return row.expiresAt && row.expiresAt > now ? "reuse" : "expired";
  }
  if (row.state === "failed") return "definitive_failure";
  return "reconcile";
}

export function webhookBindingValid(input: {
  userId: string | null;
  requestedPlan: PaidBillingPlan | null;
  mappedPlan: PaidBillingPlan | null;
  checkout: { userId: string; plan: string; state: CheckoutState } | null;
  conflictingUserId: string | null;
}): boolean {
  return Boolean(
    input.userId &&
      input.requestedPlan &&
      input.mappedPlan &&
      input.checkout &&
      input.checkout.userId === input.userId &&
      input.checkout.plan === input.requestedPlan &&
      ["created", "creating", "uncertain"].includes(input.checkout.state) &&
      input.mappedPlan === input.requestedPlan &&
      (!input.conflictingUserId || input.conflictingUserId === input.userId),
  );
}

/**
 * A signed event may change products through the provider portal without
 * changing the subscription/customer owner binding. The checkout's original
 * requested plan is intentionally not part of this durable-binding check.
 */
export function subscriptionWebhookBindingValid(input: {
  userId: string | null;
  suppliedUserId: string | null;
  mappedPlan: PaidBillingPlan | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  subscription: {
    userId: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
  } | null;
}): boolean {
  return Boolean(
    input.userId &&
      input.mappedPlan &&
      input.providerSubscriptionId &&
      input.providerCustomerId &&
      input.subscription &&
      input.subscription.userId === input.userId &&
      (!input.suppliedUserId || input.suppliedUserId === input.userId) &&
      input.subscription.providerSubscriptionId === input.providerSubscriptionId &&
      input.subscription.providerCustomerId === input.providerCustomerId,
  );
}
