import { z } from "zod";

export type BillingPlan = "starter" | "standard" | "pro";
export type PaidBillingPlan = Exclude<BillingPlan, "starter">;

export type PlanLimits = {
  servers: number;
  ramMb: number;
  cpuCores: number;
  storageGb: number;
  backups: number;
};

/** The single source used for both entitlement projection and quota admission. */
export const PLAN_LIMITS: Readonly<Record<BillingPlan, PlanLimits>> = {
  starter: { servers: 1, ramMb: 2_048, cpuCores: 2, storageGb: 5, backups: 3 },
  standard: { servers: 3, ramMb: 8_192, cpuCores: 6, storageGb: 40, backups: 12 },
  pro: { servers: 8, ramMb: 32_768, cpuCores: 16, storageGb: 200, backups: 40 },
};

const envSchema = z.object({
  DODO_PAYMENTS_API_KEY: z.string().trim().min(1),
  DODO_PAYMENTS_WEBHOOK_KEY: z.string().trim().min(1),
  DODO_PAYMENTS_ENVIRONMENT: z.enum(["test_mode", "live_mode"]),
  DODO_STANDARD_PRODUCT_ID: z.string().trim().min(1),
  DODO_PRO_PRODUCT_ID: z.string().trim().min(1),
  BETTER_AUTH_URL: z.string().trim().url(),
});

export type BillingConfig = {
  apiKey: string;
  webhookKey: string;
  environment: "test_mode" | "live_mode";
  apiBaseUrl: string;
  appBaseUrl: string;
  products: Readonly<Record<PaidBillingPlan, string>>;
};

export type BillingConfigState =
  | { enabled: false; reason: "not_configured" | "invalid_configuration" }
  | { enabled: true; config: BillingConfig };

function safeApplicationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function readBillingConfig(
  env: Record<string, string | undefined> = process.env,
): BillingConfigState {
  const relevant = [
    env.DODO_PAYMENTS_API_KEY,
    env.DODO_PAYMENTS_WEBHOOK_KEY,
    env.DODO_PAYMENTS_ENVIRONMENT,
    env.DODO_STANDARD_PRODUCT_ID,
    env.DODO_PRO_PRODUCT_ID,
  ];
  if (relevant.every((value) => !value?.trim())) {
    return { enabled: false, reason: "not_configured" };
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) return { enabled: false, reason: "invalid_configuration" };

  const appBaseUrl = safeApplicationUrl(parsed.data.BETTER_AUTH_URL);
  if (!appBaseUrl || parsed.data.DODO_STANDARD_PRODUCT_ID === parsed.data.DODO_PRO_PRODUCT_ID) {
    return { enabled: false, reason: "invalid_configuration" };
  }

  return {
    enabled: true,
    config: {
      apiKey: parsed.data.DODO_PAYMENTS_API_KEY,
      webhookKey: parsed.data.DODO_PAYMENTS_WEBHOOK_KEY,
      environment: parsed.data.DODO_PAYMENTS_ENVIRONMENT,
      apiBaseUrl:
        parsed.data.DODO_PAYMENTS_ENVIRONMENT === "test_mode"
          ? "https://test.dodopayments.com"
          : "https://live.dodopayments.com",
      appBaseUrl,
      products: {
        standard: parsed.data.DODO_STANDARD_PRODUCT_ID,
        pro: parsed.data.DODO_PRO_PRODUCT_ID,
      },
    },
  };
}

export function planForProduct(
  productId: string,
  products: Readonly<Record<PaidBillingPlan, string>>,
): PaidBillingPlan | null {
  if (productId === products.standard) return "standard";
  if (productId === products.pro) return "pro";
  return null;
}

export function quotaValuesForPlan(plan: BillingPlan) {
  const limits = PLAN_LIMITS[plan];
  return {
    plan,
    serversLimit: limits.servers,
    ramLimitMb: limits.ramMb,
    cpuLimit: String(limits.cpuCores),
    storageLimitGb: limits.storageGb,
    backupsLimit: limits.backups,
  } as const;
}
