"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

type BillingPlan = "starter" | "standard" | "pro";
type PaidBillingPlan = Exclude<BillingPlan, "starter">;

type BillingLimits = {
  servers: number;
  ram_mb: number;
  cpu_cores: number;
  storage_gb: number;
  backups: number;
};

type BillingPlanSummary = {
  plan: BillingPlan;
  configured: boolean;
  limits: BillingLimits;
};

type BillingSummaryResponse = {
  provider: "dodo_payments";
  enabled: boolean;
  current_plan: BillingPlan;
  plans: BillingPlanSummary[];
  subscription: {
    plan: PaidBillingPlan;
    status: string;
    cancel_at_next_billing_date: boolean;
    next_billing_date: string | null;
  } | null;
  can_manage_billing: boolean;
};

type BillingCheckoutResponse = {
  checkout_url: string;
  session_id: string;
  reused: boolean;
};

type BillingPortalResponse = {
  portal_url: string;
};

const PLAN_ORDER: Record<BillingPlan, number> = {
  starter: 0,
  standard: 1,
  pro: 2,
};
const CHECKOUT_MANAGED_STATUSES = new Set(["active", "pending", "on_hold", "paused"]);

function planLabel(plan: BillingPlan): string {
  return plan[0].toUpperCase() + plan.slice(1);
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMemory(megabytes: number): string {
  if (megabytes >= 1024) {
    const gigabytes = megabytes / 1024;
    return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
  }
  return `${megabytes} MB`;
}

function formatCpu(cores: number): string {
  return `${cores} ${cores === 1 ? "core" : "cores"}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Billing could not be opened. Please try again.";
}

export function BillingPanel() {
  const [returnNotice, setReturnNotice] = useState<"return" | "cancel" | null>(null);
  const [awaitingWebhook, setAwaitingWebhook] = useState(false);

  const billing = useQuery<BillingSummaryResponse>({
    queryKey: ["billing"],
    queryFn: () => api<BillingSummaryResponse>("/api/billing"),
    refetchInterval: (query) =>
      awaitingWebhook && query.state.data?.current_plan === "starter" ? 3_000 : false,
    retry: 1,
  });

  const checkout = useMutation({
    mutationFn: (plan: PaidBillingPlan) =>
      api<BillingCheckoutResponse>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          plan,
          request_key: `${plan}:${crypto.randomUUID()}`,
        }),
      }),
    onSuccess: ({ checkout_url: checkoutUrl }) => window.location.assign(checkoutUrl),
  });

  const portal = useMutation({
    mutationFn: () =>
      api<BillingPortalResponse>("/api/billing/portal", {
        method: "POST",
      }),
    onSuccess: ({ portal_url: portalUrl }) => window.location.assign(portalUrl),
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("billing");
    if (result !== "return" && result !== "cancel") return;

    setReturnNotice(result);
    if (result === "return") setAwaitingWebhook(true);
    url.searchParams.delete("billing");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    const timeout = window.setTimeout(() => setAwaitingWebhook(false), 60_000);
    return () => window.clearTimeout(timeout);
  }, []);

  const summary = billing.data;
  const plans = summary
    ? [...summary.plans].sort((left, right) => PLAN_ORDER[left.plan] - PLAN_ORDER[right.plan])
    : [];
  const billingPending = checkout.isPending || portal.isPending;
  const actionError = checkout.error ?? portal.error;
  const checkoutManaged = summary?.subscription
    ? CHECKOUT_MANAGED_STATUSES.has(summary.subscription.status)
    : false;

  return (
    <section className="billing-section" aria-labelledby="billing-heading">
      <div className="section-heading billing-heading-row">
        <div>
          <p className="eyebrow">Dodo Payments</p>
          <h3 id="billing-heading">Billing plans</h3>
        </div>
        {summary?.can_manage_billing ? (
          <button
            className="billing-secondary-action"
            disabled={billingPending}
            onClick={() => {
              checkout.reset();
              portal.mutate();
            }}
            type="button"
          >
            <CreditCard aria-hidden="true" size={15} />
            {portal.isPending ? "Opening…" : "Manage billing"}
          </button>
        ) : null}
      </div>

      {returnNotice === "return" ? (
        <div className="billing-notice good" role="status">
          <Check aria-hidden="true" size={17} />
          <span>
            Checkout finished. Your plan updates here only after Dodo confirms the subscription.
          </span>
        </div>
      ) : null}

      {returnNotice === "cancel" ? (
        <div className="billing-notice quiet" role="status">
          <CircleAlert aria-hidden="true" size={17} />
          <span>Checkout was cancelled. Your current plan is unchanged.</span>
        </div>
      ) : null}

      {billing.isPending ? (
        <div className="billing-loading" role="status">
          <span className="sr-only">Loading billing plans</span>
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {billing.isError ? (
        <div className="billing-unavailable" role="alert">
          <CircleAlert aria-hidden="true" size={18} />
          <div>
            <strong>Billing plans are unavailable</strong>
            <span>Your current quota is unchanged. Retry the billing connector when ready.</span>
          </div>
          <button
            className="billing-secondary-action"
            onClick={() => void billing.refetch()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} /> Retry
          </button>
        </div>
      ) : null}

      {summary ? (
        <>
          {!summary.enabled ? (
            <p className="billing-disabled-note" role="status">
              Paid plans are not configured yet. Starter limits remain active.
            </p>
          ) : null}

          {summary.subscription ? (
            <div className="billing-subscription-summary">
              <span>
                {planLabel(summary.subscription.plan)} subscription ·{" "}
                {statusLabel(summary.subscription.status)}
              </span>
              {summary.subscription.next_billing_date ? (
                <small>
                  {summary.subscription.cancel_at_next_billing_date ? "Ends" : "Renews"}{" "}
                  {formatDate(summary.subscription.next_billing_date)}
                </small>
              ) : null}
            </div>
          ) : null}

          <div className="billing-plan-list">
            {plans.map(({ configured, limits, plan }) => {
              const current = summary.current_plan === plan;
              const paidPlan = plan !== "starter";
              const selectable =
                paidPlan && configured && summary.enabled && !current && !checkoutManaged;
              const actionLabel = current
                ? "Current plan"
                : !paidPlan
                  ? "Included"
                  : !configured || !summary.enabled
                    ? "Unavailable"
                    : checkoutManaged
                      ? "Use billing portal"
                      : `Choose ${planLabel(plan)}`;

              return (
                <article className={current ? "billing-plan current" : "billing-plan"} key={plan}>
                  <div className="billing-plan-name">
                    <div>
                      <h4>{planLabel(plan)}</h4>
                      {current ? <span className="billing-current-badge">Current</span> : null}
                    </div>
                    <button
                      className={selectable ? "billing-primary-action" : "billing-plan-action"}
                      disabled={!selectable || billingPending}
                      onClick={() => {
                        if (!selectable) return;
                        portal.reset();
                        checkout.mutate(plan);
                      }}
                      type="button"
                    >
                      {checkout.isPending && checkout.variables === plan ? (
                        "Opening…"
                      ) : (
                        <>
                          {actionLabel}
                          {selectable ? <ExternalLink aria-hidden="true" size={14} /> : null}
                        </>
                      )}
                    </button>
                  </div>
                  <dl className="billing-limit-list">
                    <div>
                      <dt>Realms</dt>
                      <dd>{limits.servers}</dd>
                    </div>
                    <div>
                      <dt>CPU</dt>
                      <dd>{formatCpu(limits.cpu_cores)}</dd>
                    </div>
                    <div>
                      <dt>Memory</dt>
                      <dd>{formatMemory(limits.ram_mb)}</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>{limits.storage_gb} GB</dd>
                    </div>
                    <div>
                      <dt>Backups</dt>
                      <dd>{limits.backups}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>

          <p className="billing-footnote">
            Pricing and payment details are confirmed in Dodo&apos;s secure checkout. A checkout
            return never changes your plan by itself.
          </p>
        </>
      ) : null}

      {actionError ? (
        <p className="auth-error billing-action-error" role="alert">
          {actionErrorMessage(actionError)}
        </p>
      ) : null}
    </section>
  );
}
