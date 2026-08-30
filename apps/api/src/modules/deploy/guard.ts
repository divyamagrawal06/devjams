import { backups, deployments } from "@repo/db";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import { db } from "../../db";

export class ServerCutoverInProgressError extends Error {
  constructor(serverId: string) {
    super(`Server '${serverId}' has a deployment cutover awaiting reconciliation`);
    this.name = "ServerCutoverInProgressError";
  }
}

export class ServerBackupInProgressError extends Error {
  constructor(serverId: string) {
    super(`Server '${serverId}' has a backup operation awaiting reconciliation`);
    this.name = "ServerBackupInProgressError";
  }
}

/**
 * Legacy workers created before per-server Leases can still be running during
 * the rollout. Check the durable catalog claim after acquiring the shared
 * Lease so lifecycle and cutover controllers cannot mutate the same PVC.
 * Pending/in-progress rows are included for old API instances that wrote
 * after the schema migration but before the new attempt fields were adopted.
 */
export async function assertNoActiveServerBackup(serverId: string): Promise<void> {
  const [active] = await db
    .select({ id: backups.id })
    .from(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        or(isNotNull(backups.activeOperation), inArray(backups.status, ["pending", "in_progress"])),
      ),
    )
    .limit(1);
  if (active) throw new ServerBackupInProgressError(serverId);
}

/**
 * A Kubernetes Lease is the fast mutual-exclusion path. This durable guard
 * remains after a controller crash and prevents lifecycle work from operating
 * on the old PVC after the route has moved but before serverK8s is promoted.
 */
export async function assertNoPendingServerCutover(serverId: string): Promise<void> {
  const [active] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(eq(deployments.serverId, serverId), inArray(deployments.state, ["cutover", "draining"])),
    )
    .limit(1);
  if (active) throw new ServerCutoverInProgressError(serverId);
}
