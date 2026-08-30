import { billingSubscriptions, userQuotas } from "@repo/db";
import { eq } from "drizzle-orm";

import { db, type TransactionType } from "../../db";
import { quotaValuesForPlan } from "./config";

export type TimeBoundEntitlement = {
  entitlementState: string;
  status: string;
  cancelAtNextBillingDate: boolean;
  nextBillingDate: Date | null;
  graceUntil: Date | null;
};

export function timeBoundEntitlementHasEnded(
  entitlement: TimeBoundEntitlement,
  now: Date,
): boolean {
  const expiredGrace =
    entitlement.entitlementState === "grace" &&
    entitlement.graceUntil !== null &&
    entitlement.graceUntil <= now;
  const endedCancellation =
    entitlement.entitlementState === "active" &&
    entitlement.status === "cancelled" &&
    entitlement.cancelAtNextBillingDate &&
    entitlement.nextBillingDate !== null &&
    entitlement.nextBillingDate <= now;

  return expiredGrace || endedCancellation;
}

/**
 * Reconciles wall-clock entitlement boundaries on the caller's transaction.
 * Admission paths call this before locking and reading the quota projection so
 * an expired paid limit cannot be used between reconciliation and allocation.
 */
export async function reconcileTimeBoundEntitlementInTransaction(
  userId: string,
  now: Date,
  tx: TransactionType,
): Promise<boolean> {
  const [subscription] = await tx
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId))
    .for("update");
  if (!subscription || !timeBoundEntitlementHasEnded(subscription, now)) return false;

  await tx
    .update(billingSubscriptions)
    .set({ entitlementState: "starter", graceUntil: null, updatedAt: now })
    .where(eq(billingSubscriptions.userId, userId));
  await tx
    .update(userQuotas)
    .set({ ...quotaValuesForPlan("starter"), updatedAt: now })
    .where(eq(userQuotas.userId, userId));

  return true;
}

export async function reconcileTimeBoundEntitlement(
  userId: string,
  now = new Date(),
): Promise<boolean> {
  return db.transaction((tx) => reconcileTimeBoundEntitlementInTransaction(userId, now, tx));
}
