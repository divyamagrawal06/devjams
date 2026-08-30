import { describe, expect, test } from "bun:test";

import {
  availablePowerActions,
  freshnessState,
  projectedQuotaIssues,
  shouldClearPowerRequestKey,
} from "../components/operator-home";
import type { QuotaUsage } from "./api";
import { operatorReceiptOutcome } from "./operator-receipts";

const quota: QuotaUsage = {
  plan: "standard",
  cpuLimit: "6",
  cpuUsed: "3",
  ramLimitMb: 8192,
  ramUsedMb: 4096,
  storageLimitGb: 40,
  storageUsedGb: 20,
  serversLimit: 3,
  serversUsed: 2,
  backupsLimit: 12,
  backupsUsed: 4,
  overQuota: false,
};

describe("Operator Home safety helpers", () => {
  test("enables only controls accepted by the observed state machine", () => {
    expect(availablePowerActions("running")).toEqual(["stop", "restart"]);
    expect(availablePowerActions("stopped")).toEqual(["start"]);
    expect(availablePowerActions("failed")).toEqual(["start"]);
    expect(availablePowerActions("starting")).toEqual(["stop"]);
    expect(availablePowerActions("provisioning")).toEqual([]);
  });

  test("never presents disconnected or old data as fresh", () => {
    const now = 100_000;
    expect(freshnessState(95_000, now, "connected")).toEqual({
      stale: false,
      label: "Observed 5s ago",
    });
    expect(freshnessState(60_000, now, "connected").stale).toBe(true);
    expect(freshnessState(99_000, now, "unavailable").stale).toBe(true);
    expect(freshnessState(0, now, "connected")).toEqual({
      stale: true,
      label: "No confirmed observation",
    });
  });

  test("blocks onboarding against projected aggregate usage", () => {
    expect(projectedQuotaIssues(quota, { cpuCores: 3, ramMb: 4096, storageGb: 20 })).toEqual([]);
    expect(projectedQuotaIssues(quota, { cpuCores: 4, ramMb: 5000, storageGb: 21 })).toEqual([
      "CPU",
      "memory",
      "storage",
    ]);
    expect(
      projectedQuotaIssues({ ...quota, serversUsed: 3 }, { cpuCores: 1, ramMb: 512, storageGb: 2 }),
    ).toContain("workload count");
    expect(projectedQuotaIssues(null, { cpuCores: 1, ramMb: 512, storageGb: 2 })).toEqual([
      "Account quota is unavailable.",
    ]);
  });

  test("retains an idempotency key until a control receipt is completed", () => {
    expect(shouldClearPowerRequestKey("accepted")).toBe(false);
    expect(shouldClearPowerRequestKey("failed")).toBe(false);
    expect(shouldClearPowerRequestKey("refused")).toBe(false);
    expect(shouldClearPowerRequestKey("completed")).toBe(true);
    expect(operatorReceiptOutcome("accepted")).toMatchObject({ pending: true, completed: false });
    expect(operatorReceiptOutcome("failed")).toMatchObject({ retryable: true, completed: false });
    expect(operatorReceiptOutcome("refused")).toMatchObject({ retryable: true, completed: false });
    expect(operatorReceiptOutcome("completed")).toMatchObject({
      clearRequestKey: true,
      completed: true,
    });
  });
});
