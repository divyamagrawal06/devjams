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
