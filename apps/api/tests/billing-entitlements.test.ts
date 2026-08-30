import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhook } from "standardwebhooks";

import {
  PLAN_LIMITS,
  planForProduct,
  quotaValuesForPlan,
  readBillingConfig,
} from "../src/modules/billing/config";
import { checkoutDisposition, webhookBindingValid } from "../src/modules/billing/policy";
import {
  decideSubscriptionProjection,
  effectivePlan,
  type ProjectableBillingEvent,
  type SubscriptionProjection,
} from "../src/modules/billing/projection";
import {
  DodoBillingProvider,
  ProviderDefinitiveError,
  ProviderUncertainError,
} from "../src/modules/billing/provider";
import { verifyBillingWebhook } from "../src/modules/billing/webhook";

const products = { standard: "prod_standard", pro: "prod_pro" } as const;
const eventBase: ProjectableBillingEvent = {
  eventId: "evt_002",
  occurredAt: new Date("2026-08-30T12:00:00.000Z"),
  plan: "standard",
  providerSubscriptionId: "sub_owner",
  providerCustomerId: "cus_owner",
  providerProductId: products.standard,
  status: "active",
  cancelAtNextBillingDate: false,
  nextBillingDate: new Date("2026-09-30T12:00:00.000Z"),
};

function applied(event: ProjectableBillingEvent): SubscriptionProjection {
  const decision = decideSubscriptionProjection(event, {
    alreadyProcessed: false,
    bindingValid: true,
    prior: null,
    now: new Date("2026-08-30T12:01:00.000Z"),
  });
  expect(decision.outcome).toBe("applied");
  if (decision.outcome !== "applied") throw new Error("expected projection");
  return decision.projection;
}

describe("billing configuration and quota catalogue", () => {
  test("is disabled only when every provider field is absent", () => {
    expect(readBillingConfig({})).toEqual({ enabled: false, reason: "not_configured" });
    expect(readBillingConfig({ DODO_PAYMENTS_API_KEY: "partial" })).toEqual({
      enabled: false,
      reason: "invalid_configuration",
    });
  });

  test("requires distinct products and a safe application return origin", () => {
    const base = {
      DODO_PAYMENTS_API_KEY: "api",
      DODO_PAYMENTS_WEBHOOK_KEY: "whsec_dGVzdA==",
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
      DODO_STANDARD_PRODUCT_ID: "standard",
      DODO_PRO_PRODUCT_ID: "pro",
      BETTER_AUTH_URL: "https://console.example.test/",
    };
    expect(readBillingConfig(base)).toMatchObject({
      enabled: true,
      config: {
        apiBaseUrl: "https://test.dodopayments.com",
        appBaseUrl: "https://console.example.test",
      },
    });
    expect(readBillingConfig({ ...base, DODO_PRO_PRODUCT_ID: "standard" })).toEqual({
      enabled: false,
      reason: "invalid_configuration",
    });
    expect(readBillingConfig({ ...base, BETTER_AUTH_URL: "http://public.example.test" })).toEqual({
      enabled: false,
      reason: "invalid_configuration",
    });
  });

  test("maps products and quota rows from one exact plan catalogue", () => {
    expect(planForProduct("prod_pro", products)).toBe("pro");
    expect(planForProduct("prod_attacker", products)).toBeNull();
    expect(quotaValuesForPlan("standard")).toEqual({
      plan: "standard",
      serversLimit: 3,
      ramLimitMb: 8192,
      cpuLimit: "6",
      storageLimitGb: 40,
      backupsLimit: 12,
    });
    expect(PLAN_LIMITS.pro.backups).toBe(40);
  });
});

describe("checkout idempotency and provider boundary", () => {
  test("reuses one successful request and holds uncertain outcomes", () => {
    const future = new Date("2026-08-31T12:00:00Z");
    const now = new Date("2026-08-30T12:00:00Z");
    expect(checkoutDisposition("standard", null, now)).toBe("create");
    expect(
      checkoutDisposition(
        "standard",
        { plan: "standard", state: "created", expiresAt: future },
        now,
      ),
    ).toBe("reuse");
    expect(
      checkoutDisposition(
        "standard",
        { plan: "standard", state: "uncertain", expiresAt: null },
        now,
      ),
    ).toBe("reconcile");
    expect(
      checkoutDisposition("pro", { plan: "standard", state: "created", expiresAt: future }, now),
    ).toBe("conflict");
    expect(
      checkoutDisposition(
        "standard",
        { plan: "standard", state: "created", expiresAt: new Date("2026-08-29T12:00:00Z") },
        now,
      ),
    ).toBe("expired");
  });

  test("requires the signed product, checkout owner, plan, and existing provider binding to agree", () => {
    const base = {
      userId: "owner",
      requestedPlan: "standard" as const,
      mappedPlan: "standard" as const,
      checkout: { userId: "owner", plan: "standard", state: "created" as const },
      conflictingUserId: null,
    };
    expect(webhookBindingValid(base)).toBe(true);
    expect(
      webhookBindingValid({ ...base, checkout: { ...base.checkout, userId: "attacker" } }),
    ).toBe(false);
    expect(webhookBindingValid({ ...base, mappedPlan: "pro" })).toBe(false);
    expect(webhookBindingValid({ ...base, conflictingUserId: "another_owner" })).toBe(false);
    expect(webhookBindingValid({ ...base, checkout: { ...base.checkout, state: "failed" } })).toBe(
      false,
    );
    expect(
      webhookBindingValid({ ...base, checkout: { ...base.checkout, state: "uncertain" } }),
    ).toBe(true);
  });

  test("sends owner metadata to hosted checkout and accepts only provider HTTPS redirects", async () => {
    const configState = readBillingConfig({
      DODO_PAYMENTS_API_KEY: "api-key",
      DODO_PAYMENTS_WEBHOOK_KEY: "webhook-key",
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
      DODO_STANDARD_PRODUCT_ID: "prod_standard",
      DODO_PRO_PRODUCT_ID: "prod_pro",
      BETTER_AUTH_URL: "https://console.example.test",
    });
    if (!configState.enabled) throw new Error("expected billing config");
    let captured: Record<string, unknown> | null = null;
    const provider = new DodoBillingProvider(configState.config, async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return Response.json({
        session_id: "checkout_session",
        checkout_url: "https://checkout.dodopayments.com/session/owner",
      });
    });
    await expect(
      provider.createCheckout({
        internalCheckoutId: `bcs_${"a".repeat(32)}`,
        userId: "owner",
        email: "owner@example.test",
        name: "Owner",
        plan: "standard",
      }),
    ).resolves.toMatchObject({ sessionId: "checkout_session" });
    expect(captured).toMatchObject({
      product_cart: [{ product_id: "prod_standard", quantity: 1 }],
      metadata: {
        user_id: "owner",
        requested_plan: "standard",
        checkout_id: `bcs_${"a".repeat(32)}`,
      },
    });

    const unsafe = new DodoBillingProvider(configState.config, async () =>
      Response.json({
        session_id: "checkout_session",
        checkout_url: "https://attacker.example/session",
      }),
    );
    await expect(
      unsafe.createCheckout({
        internalCheckoutId: `bcs_${"a".repeat(32)}`,
        userId: "owner",
        email: "owner@example.test",
        name: "Owner",
        plan: "standard",
      }),
    ).rejects.toBeInstanceOf(ProviderDefinitiveError);

    const portalRequests: Array<{ body: unknown; url: string }> = [];
    const portal = new DodoBillingProvider(configState.config, async (url, init) => {
      portalRequests.push({ body: init?.body, url: String(url) });
      return Response.json({ link: "https://customer.dodopayments.com/session/owner" });
    });
    await expect(portal.createPortal("customer/owner")).resolves.toContain(
      "customer.dodopayments.com",
    );
    const portalRequest = portalRequests[0];
    if (!portalRequest) throw new Error("expected portal request");
    const portalUrl = new URL(portalRequest.url);
    expect(portalUrl.pathname).toBe("/customers/customer%2Fowner/customer-portal/session");
    expect(portalUrl.searchParams.get("return_url")).toBe(
      "https://console.example.test/?billing=return",
    );
    expect(portalRequest.body).toBeUndefined();
  });

  test("distinguishes definitive provider refusal from uncertain network outcomes", async () => {
    const configState = readBillingConfig({
      DODO_PAYMENTS_API_KEY: "api-key",
      DODO_PAYMENTS_WEBHOOK_KEY: "webhook-key",
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
      DODO_STANDARD_PRODUCT_ID: "prod_standard",
      DODO_PRO_PRODUCT_ID: "prod_pro",
      BETTER_AUTH_URL: "https://console.example.test",
    });
    if (!configState.enabled) throw new Error("expected billing config");
    const input = {
      internalCheckoutId: `bcs_${"b".repeat(32)}`,
      userId: "owner",
      email: "owner@example.test",
      name: "Owner",
      plan: "pro" as const,
    };
    const refused = new DodoBillingProvider(
      configState.config,
      async () => new Response("bad request", { status: 400 }),
    );
    await expect(refused.createCheckout(input)).rejects.toBeInstanceOf(ProviderDefinitiveError);
    const unknown = new DodoBillingProvider(configState.config, async () => {
      throw new Error("connection reset");
    });
    await expect(unknown.createCheckout(input)).rejects.toBeInstanceOf(ProviderUncertainError);
  });
});

describe("signed webhook parsing and projection", () => {
  test("verifies Standard Webhooks before extracting privacy-minimised fields", () => {
    const secret = `whsec_${Buffer.from("farlands-test-webhook-secret").toString("base64")}`;
    const timestamp = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({
      type: "subscription.active",
      data: {
        subscription_id: "sub_owner",
        customer: { customer_id: "cus_owner", email: "not-retained@example.test" },
        product_id: "prod_standard",
        status: "active",
        created_at: "2026-08-30T12:00:00.000Z",
        next_billing_date: "2026-09-30T12:00:00.000Z",
        metadata: {
          user_id: "owner",
          requested_plan: "standard",
          checkout_id: `bcs_${"a".repeat(32)}`,
        },
      },
    });
    const signer = new Webhook(secret);
    const signature = signer.sign("evt_owner", new Date(timestamp * 1_000), body);
    const verified = verifyBillingWebhook(
      body,
      {
        "webhook-id": "evt_owner",
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
      },
      secret,
    );
    expect(verified).toMatchObject({
      eventId: "evt_owner",
      providerSubscriptionId: "sub_owner",
      providerCustomerId: "cus_owner",
      providerProductId: "prod_standard",
      userId: "owner",
      requestedPlan: "standard",
    });
    expect(verified.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(verified)).not.toContain("not-retained@example.test");
    expect(() =>
      verifyBillingWebhook(
        `${body} `,
        {
          "webhook-id": "evt_owner",
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        secret,
      ),
    ).toThrow();
  });

  test("deduplicates and rejects stale or ownership/product binding failures", () => {
    const prior = applied(eventBase);
    expect(
      decideSubscriptionProjection(eventBase, {
        alreadyProcessed: true,
        bindingValid: true,
        prior,
      }).outcome,
    ).toBe("duplicate");
    expect(
      decideSubscriptionProjection(
        { ...eventBase, eventId: "evt_001", occurredAt: new Date("2026-08-30T11:59:59Z") },
        { alreadyProcessed: false, bindingValid: true, prior },
      ).outcome,
    ).toBe("stale");
    expect(
      decideSubscriptionProjection(eventBase, {
        alreadyProcessed: false,
        bindingValid: false,
        prior: null,
      }).outcome,
    ).toBe("invalid_binding");
  });

  test("uses event id as a deterministic tie-breaker for out-of-order delivery", () => {
    const prior = applied({ ...eventBase, eventId: "evt_010" });
    expect(
      decideSubscriptionProjection(
        { ...eventBase, eventId: "evt_009", status: "expired" },
        { alreadyProcessed: false, bindingValid: true, prior },
      ).outcome,
    ).toBe("stale");
  });

  test("projects active, grace, cancellation and terminal failure without auto-deleting", () => {
    const now = new Date("2026-08-30T12:01:00.000Z");
    expect(effectivePlan(applied(eventBase), now)).toBe("standard");

    const grace = applied({ ...eventBase, eventId: "evt_003", status: "on_hold" });
    expect(grace.entitlementState).toBe("grace");
    expect(effectivePlan(grace, now)).toBe("standard");
    expect(effectivePlan(grace, new Date("2026-10-01T00:00:00Z"))).toBe("starter");

    const scheduledCancellation = applied({
      ...eventBase,
      eventId: "evt_004",
      status: "cancelled",
      cancelAtNextBillingDate: true,
    });
    expect(scheduledCancellation.entitlementState).toBe("active");

    for (const status of ["expired", "cancelled", "pending"] as const) {
      const projection = applied({
        ...eventBase,
        eventId: `evt_${status}`,
        status,
        cancelAtNextBillingDate: false,
      });
      expect(projection.entitlementState).toBe("starter");
      expect(effectivePlan(projection, now)).toBe("starter");
    }
  });

  test("migration stores only a payload digest and protects owner-bound rows", () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "packages",
        "db",
        "migrations",
        "0011_operator_billing.sql",
      ),
      "utf8",
    );
    expect(migration).toContain('"payload_digest" text NOT NULL');
    expect(migration).not.toContain('"payload" jsonb');
    expect(migration).toContain("billing_checkout_user_request_idx");
    expect(migration).toContain("billing_checkout_protect_identity");
    expect(migration).toContain("maintenance_owner_server_fk");
    expect(migration).toContain("operator_receipt_owner_server_fk");
  });
});
