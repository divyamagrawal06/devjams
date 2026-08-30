import { describe, expect, test } from "bun:test";

import { connectorOriginAllowed, connectorPathAllowed } from "./connector-policy";

describe("connectorPathAllowed", () => {
  test("permits the user-scoped control-plane surfaces", () => {
    expect(connectorPathAllowed("/health")).toBe(true);
    expect(connectorPathAllowed("/api/servers/server-1/status")).toBe(true);
    expect(connectorPathAllowed("/api/quota")).toBe(true);
    expect(connectorPathAllowed("/api/operator")).toBe(true);
    expect(connectorPathAllowed("/api/operator/notifications")).toBe(true);
    expect(connectorPathAllowed("/api/operator/maintenance")).toBe(true);
    expect(connectorPathAllowed("/api/operator/maintenance/mnt_owner")).toBe(true);
    expect(connectorPathAllowed("/api/servers/templates")).toBe(true);
    expect(connectorPathAllowed("/api/billing")).toBe(true);
    expect(connectorPathAllowed("/api/billing/checkout")).toBe(true);
    expect(connectorPathAllowed("/api/billing/portal")).toBe(true);
    expect(connectorPathAllowed("/api/changes?status=pending_review")).toBe(false);
    expect(connectorPathAllowed("/api/changes")).toBe(true);
    expect(connectorPathAllowed("/api/changes/change-1/approve")).toBe(true);
    expect(connectorPathAllowed("/api/servers/server-1/events")).toBe(true);
  });

  test("rejects internal and unrelated surfaces", () => {
    expect(connectorPathAllowed("/api/servers/internal")).toBe(false);
    expect(connectorPathAllowed("/api/servers/internal/status")).toBe(false);
    expect(connectorPathAllowed("/v1/servers/another-users-server/deploy")).toBe(false);
    expect(connectorPathAllowed("/api/admin/users")).toBe(false);
    expect(connectorPathAllowed("/api/billing/subscriptions")).toBe(false);
    expect(connectorPathAllowed("/api/billing/checkout/anything-else")).toBe(false);
    expect(connectorPathAllowed("/api/operator/receipts/export")).toBe(false);
    expect(connectorPathAllowed("/metrics")).toBe(false);
    expect(connectorPathAllowed("/%2E%2E/health")).toBe(false);
  });
});

describe("connectorOriginAllowed", () => {
  test("allows reads without an Origin header", () => {
    expect(
      connectorOriginAllowed({
        method: "GET",
        origin: null,
        requestOrigin: "https://www.indexd.app",
        production: true,
      }),
    ).toBe(true);
  });

  test("requires a trusted origin for mutations", () => {
    const base = {
      method: "POST",
      requestOrigin: "https://www.indexd.app",
      production: true,
    };

    expect(connectorOriginAllowed({ ...base, origin: "https://www.indexd.app" })).toBe(true);
    expect(connectorOriginAllowed({ ...base, origin: "https://attacker.example" })).toBe(false);
    expect(connectorOriginAllowed({ ...base, origin: null })).toBe(false);
  });
});
