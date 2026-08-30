import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuleJar, readStaticRule } from "@farlands/plugin-builder";
import { Elysia } from "elysia";
import {
  assertApprovedArtifactDigest,
  rollbackTargetError,
} from "../src/modules/deploy/controller";
import { deployModule, ownsDeploymentTarget } from "../src/modules/deploy/http";

const deployApp = new Elysia().use(deployModule);

const validBody = {
  rule_set_version: 2,
  content_digest: `sha256:${"a".repeat(64)}`,
};

describe("deployment authority boundary", () => {
  test("rejects deploy, deployment reads, abort, rollback, and restore without authentication", async () => {
    const requests = [
      new Request("http://localhost/v1/servers/server-one/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      new Request("http://localhost/v1/deployments/deployment-one"),
      new Request("http://localhost/v1/deployments/deployment-one/abort", { method: "POST" }),
      new Request("http://localhost/v1/servers/server-one/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      new Request("http://localhost/v1/servers/server-one/restore", { method: "POST" }),
    ];

    for (const request of requests) {
      const response = await deployApp.handle(request);
      expect(response.status).toBe(401);
    }
  });

  test("uses the authenticated account when checking server ownership", async () => {
    const checks: Array<[string, string]> = [];
    await expect(
      ownsDeploymentTarget("owner-a", "server-a", async (userId, serverId) => {
        checks.push([userId, serverId]);
        return userId === "owner-a" && serverId === "server-a";
      }),
    ).resolves.toBe(true);
    expect(checks).toEqual([["owner-a", "server-a"]]);
  });

  test("contains no development approval token or approval stub in the live controller", () => {
    const deployRoot = join(import.meta.dir, "..", "src", "modules", "deploy");
    const controller = readFileSync(join(deployRoot, "controller.ts"), "utf8");
    const http = readFileSync(join(deployRoot, "http.ts"), "utf8");
    expect(`${controller}\n${http}`).not.toContain("dev-approval-token");
    expect(`${controller}\n${http}`).not.toContain("approvals-stub");
  });

  test("refuses any artifact whose digest differs from the reviewed digest", async () => {
    const approved = `sha256:${"a".repeat(64)}`;
    expect(() => assertApprovedArtifactDigest(approved, approved)).not.toThrow();
    expect(() => assertApprovedArtifactDigest(approved, `sha256:${"b".repeat(64)}`)).toThrow(
      /human-approved content digest/,
    );

    const built = await buildRuleJar(readStaticRule());
    expect(built.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      assertApprovedArtifactDigest(built.contentDigest, built.contentDigest),
    ).not.toThrow();
  });

  test("checks rollback targets before a single-use approval is redeemed", () => {
    expect(rollbackTargetError("server-one", "7", () => undefined)).toBe(
      "No rollback target recorded for this server",
    );
    expect(rollbackTargetError("server-one", "7", () => "6")).toBe(
      "Rollback target does not match the recorded previous version",
    );
    expect(rollbackTargetError("server-one", "7", () => "7")).toBeNull();
  });
});
