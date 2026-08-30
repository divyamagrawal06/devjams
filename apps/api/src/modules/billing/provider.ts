import { z } from "zod";

import type { BillingConfig, PaidBillingPlan } from "./config";

export class ProviderDefinitiveError extends Error {}
export class ProviderUncertainError extends Error {}

export type CheckoutRequest = {
  internalCheckoutId: string;
  userId: string;
  email: string;
  name: string;
  plan: PaidBillingPlan;
};

export type CheckoutResult = {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
};

export interface BillingProvider {
  createCheckout(input: CheckoutRequest): Promise<CheckoutResult>;
  createPortal(providerCustomerId: string): Promise<string>;
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const checkoutResponse = z.object({
  session_id: z.string().min(1),
  checkout_url: z.string().url(),
});
const portalResponse = z.object({ link: z.string().url() });

function providerRedirect(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(hostname === "dodopayments.com" || hostname.endsWith(".dodopayments.com"))
  ) {
    throw new ProviderDefinitiveError("Billing provider returned an unsafe redirect.");
  }
  return url.toString();
}

export class DodoBillingProvider implements BillingProvider {
  constructor(
    private readonly config: BillingConfig,
    private readonly request: ProviderFetch = fetch,
  ) {}

  private async post(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const signal = AbortSignal.timeout(12_000);
    let response: Response;
    try {
      response = await this.request(`${this.config.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch {
      throw new ProviderUncertainError("Billing provider outcome is unknown.");
    }

    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new ProviderUncertainError("Billing provider outcome is unknown.");
      }
      throw new ProviderDefinitiveError("Billing provider refused the request.");
    }

    try {
      return await response.json();
    } catch {
      throw new ProviderUncertainError("Billing provider returned an unreadable response.");
    }
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutResult> {
    const result = checkoutResponse.parse(
      await this.post("/checkouts", {
        product_cart: [{ product_id: this.config.products[input.plan], quantity: 1 }],
        customer: { email: input.email, name: input.name },
        return_url: `${this.config.appBaseUrl}/?billing=return`,
        cancel_url: `${this.config.appBaseUrl}/?billing=cancel`,
        metadata: {
          user_id: input.userId,
          requested_plan: input.plan,
          checkout_id: input.internalCheckoutId,
        },
      }),
    );

    return {
      sessionId: result.session_id,
      checkoutUrl: providerRedirect(result.checkout_url),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    };
  }

  async createPortal(providerCustomerId: string): Promise<string> {
    const returnUrl = `${this.config.appBaseUrl}/?billing=return`;
    const result = portalResponse.parse(
      await this.post(
        `/customers/${encodeURIComponent(providerCustomerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
      ),
    );
    return providerRedirect(result.link);
  }
}
