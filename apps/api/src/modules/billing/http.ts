import { Elysia } from "elysia";
import { z } from "zod";

import { AuthService } from "../auth/service";
import { readBillingConfig } from "./config";
import { BillingOperationError, BillingService } from "./service";
import { verifyBillingWebhook, WebhookVerificationError } from "./webhook";

function failure(error: unknown, set: { status?: number | string }) {
  if (error instanceof BillingOperationError) {
    set.status = error.status;
    return { success: false, code: error.code, error: error.message };
  }
  console.error("Billing operation failed", {
    message: error instanceof Error ? error.message : "Unknown billing failure",
  });
  set.status = 500;
  return {
    success: false,
    code: "billing_operation_failed",
    error: "Billing could not be updated.",
  };
}

export const billingWebhookModule = new Elysia({ name: "billing-webhook" }).post(
  "/api/billing/webhooks/dodo",
  async ({ request, headers, set }) => {
    const configState = readBillingConfig();
    if (!configState.enabled) {
      set.status = 503;
      return { success: false, error: "Billing webhook is unavailable." };
    }

    try {
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, "utf8") > 256_000) {
        set.status = 413;
        return { success: false, error: "Webhook payload is too large." };
      }
      const event = verifyBillingWebhook(rawBody, headers, configState.config.webhookKey);
      return { success: true, data: await BillingService.applyWebhook(configState.config, event) };
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        set.status = 401;
        return { success: false, error: "Webhook signature is invalid." };
      }
      if (error instanceof z.ZodError) {
        set.status = 400;
        return { success: false, error: "Webhook payload is invalid." };
      }
      return failure(error, set);
    }
  },
  { parse: "none" },
);

const checkoutSchema = z.object({
  plan: z.enum(["standard", "pro"]),
  request_key: z
    .string()
    .min(8)
    .max(120)
    .regex(/^[A-Za-z0-9:_-]+$/, "request_key contains unsupported characters"),
});

export const billingModule = new Elysia({ prefix: "/api/billing", name: "billing" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserIdFromHeaders(headers),
  }))
  .get("/", async ({ userId, set }) => {
    try {
      return await BillingService.summary(userId);
    } catch (error) {
      return failure(error, set);
    }
  })
  .post("/checkout", async ({ headers, body, set }) => {
    try {
      const userId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
      const input = checkoutSchema.parse(body);
      return await BillingService.createCheckout(userId, input.plan, input.request_key);
    } catch (error) {
      if (error instanceof z.ZodError) {
        set.status = 400;
        return {
          success: false,
          code: "invalid_checkout_request",
          error: "Checkout request is invalid.",
        };
      }
      return failure(error, set);
    }
  })
  .post("/portal", async ({ headers, set }) => {
    try {
      const userId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
      return await BillingService.createPortal(userId);
    } catch (error) {
      return failure(error, set);
    }
  });
