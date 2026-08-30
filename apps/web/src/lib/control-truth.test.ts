import { describe, expect, test } from "bun:test";

import { evaluateControlTruth } from "./control-truth";

const base = {
  connectorState: "connected" as const,
  now: 50_000,
  observedAt: 40_000,
  online: true,
};

describe("evaluateControlTruth", () => {
  test("permits controls only with a fresh connected observation", () => {
    expect(evaluateControlTruth(base).state).toBe("verified");
    expect(evaluateControlTruth(base).canMutate).toBe(true);
  });

  test("locks controls immediately when offline", () => {
    expect(evaluateControlTruth({ ...base, online: false })).toMatchObject({
      canMutate: false,
      state: "offline",
    });
  });

  test("distinguishes unavailable, checking, and stale truth", () => {
    expect(evaluateControlTruth({ ...base, connectorState: "unavailable" }).state).toBe(
      "unavailable",
    );
    expect(evaluateControlTruth({ ...base, connectorState: "checking" }).state).toBe("checking");
    expect(evaluateControlTruth({ ...base, observedAt: 19_999 }).state).toBe("stale");
  });
});
