import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { deleteCutoverResourceWithFence } from "../src/modules/deploy/cutover";

describe("cutover cleanup Lease fencing", () => {
  test("a paused cleanup cannot delete a successor's replacement resource", async () => {
    const oldResource = {
      metadata: { uid: "old-recovery-uid", resourceVersion: "17" },
    };
    const successorResource = {
      metadata: { uid: "successor-recovery-uid", resourceVersion: "18" },
    };
    const operations: string[] = [];
    let liveResource = oldResource;
    let deletedUid: string | null = null;

    await expect(
      deleteCutoverResourceWithFence(
        "cutover recovery Job 'fl-owner/job-save-on-deploy'",
        async () => {
          operations.push(`read:${liveResource.metadata.uid}`);
          return liveResource;
        },
        async (identity) => {
          operations.push(`delete:${identity.uid}:${identity.resourceVersion}`);
          if (identity.uid !== liveResource.metadata.uid) throw { statusCode: 409 };
          deletedUid = liveResource.metadata.uid;
        },
        async () => {
          operations.push("lease-fence");
          // Model the old controller pausing while a successor acquires the
          // Lease, cleans the old object, and creates the same deterministic
          // name with a new Kubernetes identity.
          liveResource = successorResource;
          return 60_000;
        },
      ),
    ).rejects.toEqual({ statusCode: 409 });

    expect(deletedUid).toBeNull();
    expect(operations).toEqual([
      "read:old-recovery-uid",
      "lease-fence",
      "delete:old-recovery-uid:17",
    ]);
  });

  test("threads the Lease fence and identity preconditions through all cleanup deletes", () => {
    const cutover = readFileSync(
      new URL("../src/modules/deploy/cutover.ts", import.meta.url),
      "utf8",
    );
    const controller = readFileSync(
      new URL("../src/modules/deploy/controller.ts", import.meta.url),
      "utf8",
    );
    const cleanup = cutover.slice(
      cutover.indexOf("export async function cleanupCutoverResources("),
      cutover.indexOf("export function candidateProxyTarget("),
    );

    expect(cleanup.match(/await deleteCutoverResourceWithFence\(/g)).toHaveLength(2);
    expect(cleanup).toContain("batch.readNamespacedJob(");
    expect(cleanup).toContain("core.readNamespacedConfigMap(");
    expect(cleanup.match(/body: \{ preconditions \}/g)).toHaveLength(2);
    expect(controller).toContain(
      "cleanupCutover(row: DeploymentRecord, assertLeaseHeld: LeaseFence)",
    );
    expect(controller.match(/runtime\.cleanupCutover\([^;]+assertLeaseHeld\)/g)).toHaveLength(4);
  });
});
