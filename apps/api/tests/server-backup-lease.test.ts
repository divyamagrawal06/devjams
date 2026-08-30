import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function functionSlice(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("server lifecycle backup Lease", () => {
  test("renews one authoritative ownership window without bridging an expiry gap", () => {
    const serverService = readFixture("../src/modules/servers/service.ts");
    const wrapper = functionSlice(
      serverService,
      "async function withServerBackupLease<T>(",
      "function isActiveNameConflict(",
    );
    const renewal = functionSlice(
      wrapper,
      "const renewOnce = (): Promise<void> => {",
      "const settleRenewal = async (): Promise<void> => {",
    );

    expect(wrapper).toContain("confirmedUntil = (");
    expect(wrapper).toContain("SERVER_BACKUP_LEASE_RENEW_INTERVAL_MS");
    expect(wrapper).toContain("return await run(assertLeaseHeld)");
    expect(
      renewal.indexOf("assertBackupLeaseFence(previousConfirmedUntil, requestStartedAt)"),
    ).toBeGreaterThanOrEqual(0);
    const acquire = renewal.indexOf("await acquireBackupLease(");
    const response = renewal.indexOf("const responseReceivedAt = Date.now()", acquire);
    const noGapFence = renewal.indexOf("assertBackupLeaseRenewalFence(", response);
    const acceptDeadline = renewal.indexOf("confirmedUntil = renewedUntil.getTime()", noGapFence);
    expect(acquire).toBeGreaterThan(
      renewal.indexOf("assertBackupLeaseFence(previousConfirmedUntil, requestStartedAt)"),
    );
    expect(response).toBeGreaterThan(acquire);
    expect(noGapFence).toBeGreaterThan(response);
    expect(acceptDeadline).toBeGreaterThan(noGapFence);

    const asyncFence = functionSlice(
      wrapper,
      "const assertLeaseHeld: ServerBackupLeaseFence = async () => {",
      "const renewalTimer = setInterval(",
    );
    expect(asyncFence).toContain("await settleRenewal()");
    expect(asyncFence).toContain("await assertNoActiveServerBackup(serverId)");
    expect(asyncFence).toContain("await assertNoPendingServerCutover(serverId)");
    expect(asyncFence.match(/await settleRenewal\(\)/g)).toHaveLength(2);
    expect(wrapper).toContain("if (renewalFailure !== null)");
    expect(wrapper).toContain("await renewOnce()");

    const stopRenewals = wrapper.indexOf("renewalsStopped = true");
    const awaitInFlight = wrapper.indexOf(
      "await awaitInFlightRenewalBeforeRelease()",
      stopRenewals,
    );
    const release = wrapper.indexOf("await releaseBackupLeaseWithRetry(", awaitInFlight);
    expect(stopRenewals).toBeGreaterThanOrEqual(0);
    expect(awaitInFlight).toBeGreaterThan(stopRenewals);
    expect(release).toBeGreaterThan(awaitInFlight);
  });

  test("fences every server Kubernetes mutation and compensation", () => {
    const serverService = readFixture("../src/modules/servers/service.ts");
    const provisioning = readFixture("../src/modules/provisioning/service.ts");

    for (const [start, end, mutation] of [
      [
        "private static async setReplicas(",
        "private static async triggerRollingRestart(",
        "patchNamespacedDeployment(",
      ],
      [
        "private static async triggerRollingRestart(",
        "private static async settleState(",
        "patchNamespacedDeployment(",
      ],
      [
        "private static async patchDeploymentResources(",
        "private static async patchConfigMap(",
        "patchNamespacedDeployment(",
      ],
      [
        "private static async patchConfigMap(",
        "private static async resolveDeploymentConfigMap(",
        "patchNamespacedConfigMap(",
      ],
    ] as const) {
      const helper = functionSlice(serverService, start, end);
      expect(helper.indexOf("await assertLeaseHeld()")).toBeGreaterThanOrEqual(0);
      expect(helper.indexOf(mutation)).toBeGreaterThan(helper.indexOf("await assertLeaseHeld()"));
    }

    const action = functionSlice(
      serverService,
      "private static async performActionOnce(",
      "static async getStatus(",
    );
    const replicaMutations = [...action.matchAll(/this\.setReplicas\([\s\S]*?\);/g)].map(
      (match) => match[0],
    );
    expect(replicaMutations).toHaveLength(5);
    expect(replicaMutations.every((call) => call.includes("assertLeaseHeld"))).toBe(true);
    const transitionClaim = action.indexOf("await this.claimTransition(");
    expect(action.lastIndexOf("await assertLeaseHeld();", transitionClaim)).toBeGreaterThanOrEqual(
      0,
    );

    const config = functionSlice(
      serverService,
      "static async updateServerConfig(",
      "private static publicReceipt(",
    );
    expect(config).toContain("async (assertLeaseHeld) =>");
    const configPersist = config.indexOf("const persistedAt = new Date()");
    expect(config.lastIndexOf("await assertLeaseHeld();", configPersist)).toBeGreaterThanOrEqual(0);
    expect(config).toContain("this.patchDeploymentResources(");
    expect(config).toContain("this.patchConfigMap(");
    expect(config).toContain("this.triggerRollingRestart(");

    const serverDelete = functionSlice(
      serverService,
      "static async delete(userId: string, serverId: string)",
      "\n  }\n}",
    );
    expect(serverDelete).toContain("deleteGameServer(serverId, assertLeaseHeld)");
    const deleteTransaction = serverDelete.indexOf("await db.transaction(");
    expect(
      serverDelete.lastIndexOf("await assertLeaseHeld();", deleteTransaction),
    ).toBeGreaterThanOrEqual(0);

    const resourceDelete = functionSlice(
      provisioning,
      "async function deleteKubernetesResources(",
      "async function persistProvisioningState(",
    );
    const fence = resourceDelete.indexOf("await assertMutationAllowed()");
    const mutation = resourceDelete.indexOf("await deleteHandlers[resource]()", fence);
    expect(fence).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(fence);
  });
});
