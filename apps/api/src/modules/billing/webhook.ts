import { createHash } from "node:crypto";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { z } from "zod";

import type { PaidBillingPlan } from "./config";

const eventSchema = z.object({
  type: z.string().min(1),
  timestamp: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

export type VerifiedBillingEvent = {
  eventId: string;
  eventType: string;
  payloadDigest: string;
  occurredAt: Date;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  providerProductId: string | null;
  status: string | null;
  userId: string | null;
  requestedPlan: PaidBillingPlan | null;
  checkoutId: string | null;
  cancelAtNextBillingDate: boolean;
  nextBillingDate: Date | null;
};

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    if (typeof record[name] === "string" && record[name]) return record[name] as string;
  }
  return null;
}

function dateField(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function metadataFrom(data: Record<string, unknown>): Record<string, unknown> {
  return data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? (data.metadata as Record<string, unknown>)
    : {};
}

export function verifyBillingWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
  webhookSecret: string,
): VerifiedBillingEvent {
  const eventId = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (!eventId || !timestamp || !signature) throw new WebhookVerificationError("Missing headers");

  const verified = new Webhook(webhookSecret).verify(rawBody, {
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  });
  const parsed = eventSchema.parse(verified);
  const metadata = metadataFrom(parsed.data);
  const customer =
    parsed.data.customer &&
    typeof parsed.data.customer === "object" &&
    !Array.isArray(parsed.data.customer)
      ? (parsed.data.customer as Record<string, unknown>)
      : {};
  const headerDate = new Date(Number(timestamp) * 1_000);
  const occurredAt =
    dateField(parsed.data.updated_at) ??
    dateField(parsed.data.created_at) ??
    dateField(parsed.timestamp) ??
    headerDate;
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new WebhookVerificationError("Invalid occurrence time");
  }

  const requestedPlanRaw = stringField(metadata, "requested_plan");
  const requestedPlan =
    requestedPlanRaw === "standard" || requestedPlanRaw === "pro" ? requestedPlanRaw : null;

  return {
    eventId,
    eventType: parsed.type,
    payloadDigest: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
    occurredAt,
    providerSubscriptionId: stringField(parsed.data, "subscription_id", "id"),
    providerCustomerId:
      stringField(customer, "customer_id", "id") ?? stringField(parsed.data, "customer_id"),
    providerProductId: stringField(parsed.data, "product_id"),
    status: stringField(parsed.data, "status") ?? parsed.type.split(".").at(-1) ?? null,
    userId: stringField(metadata, "user_id"),
    requestedPlan,
    checkoutId: stringField(metadata, "checkout_id"),
    cancelAtNextBillingDate: parsed.data.cancel_at_next_billing_date === true,
    nextBillingDate: dateField(parsed.data.next_billing_date),
  };
}

export { WebhookVerificationError };
