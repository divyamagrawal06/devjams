import { backups, gameServers, serverConfigs, userQuotas } from "@repo/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { status } from "elysia";
import { db, type TransactionType } from "../../db";
import {
  reconcileTimeBoundEntitlement,
  reconcileTimeBoundEntitlementInTransaction,
} from "../billing/reconciliation";
import { headroomHeldByUser } from "./headroom";

export type QuotaLimits = {
  serversLimit: number;
  cpuLimit: number;
  ramLimitMb: number;
  storageLimitGb: number;
};

export type ResourceAllocation = {
  servers: number;
  cpu: number;
  ramMb: number;
  storageGb: number;
};

export function allocationViolations(limits: QuotaLimits, projected: ResourceAllocation): string[] {
  const violations: string[] = [];
  if (projected.servers > limits.serversLimit) violations.push("servers");
  if (projected.cpu > limits.cpuLimit) violations.push("cpu");
  if (projected.ramMb > limits.ramLimitMb) violations.push("ram");
  if (projected.storageGb > limits.storageLimitGb) violations.push("storage");
  return violations;
}

function allocationError(resource: string, limits: QuotaLimits): never {
  const label: Record<string, string> = {
    servers: `${limits.serversLimit} workloads`,
    cpu: `${limits.cpuLimit} CPU cores`,
    ram: `${limits.ramLimitMb}MB RAM`,
    storage: `${limits.storageLimitGb}GB storage`,
  };
  throw status(403, `Account quota exceeded. This plan allows ${label[resource]}.`);
}

export function assertAllocationFits(limits: QuotaLimits, projected: ResourceAllocation): void {
  const [first] = allocationViolations(limits, projected);
  if (first) allocationError(first, limits);
}

async function readBackupUsage(userId: string) {
  const [result] = await db
    .select({
      backupsLimit: userQuotas.backupsLimit,
      backupsUsed: sql`COUNT(DISTINCT ${backups.id})`.mapWith(Number),
    })
    .from(userQuotas)
    .leftJoin(
      gameServers,
      and(eq(gameServers.userId, userQuotas.userId), ne(gameServers.currentState, "deleted")),
    )
    .leftJoin(
      backups,
      and(
        eq(backups.serverId, gameServers.id),
        ne(backups.status, "deleted"),
        ne(backups.status, "failed"),
      ),
    )
    .where(eq(userQuotas.userId, userId))
    .groupBy(userQuotas.userId, userQuotas.backupsLimit);
  return result ?? null;
}

export abstract class QuotaService {
  /**
   * Locks the owner's quota projection and measures every non-deleted workload.
   * Failed workloads still own their volume/configured capacity and therefore
   * cannot disappear from admission accounting.
   */
  static async getResourceLimits(userId: string, tx: TransactionType) {
    await reconcileTimeBoundEntitlementInTransaction(userId, new Date(), tx);
    const [quota] = await tx
      .select()
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .for("update");
    if (!quota) return null;

    const servers = await tx
      .select({
        cpuCores: serverConfigs.cpuCores,
        ramMb: serverConfigs.ramMb,
        storageGb: serverConfigs.storageGb,
      })
      .from(gameServers)
      .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .where(and(eq(gameServers.userId, userId), ne(gameServers.currentState, "deleted")));

    const used = servers.reduce<ResourceAllocation>(
      (total, server) => ({
        servers: total.servers + 1,
        cpu: total.cpu + (Number(server.cpuCores) || 0),
        ramMb: total.ramMb + (server.ramMb || 0),
        storageGb: total.storageGb + (server.storageGb || 0),
      }),
      { servers: 0, cpu: 0, ramMb: 0, storageGb: 0 },
    );

    return {
      plan: quota.plan,
      limits: {
        serversLimit: quota.serversLimit,
        cpuLimit: Number(quota.cpuLimit),
        ramLimitMb: quota.ramLimitMb,
        storageLimitGb: quota.storageLimitGb,
      },
      used,
      backupsLimit: quota.backupsLimit,
    };
  }

  static async getBackupUsage(userId: string) {
    await reconcileTimeBoundEntitlement(userId);
    return readBackupUsage(userId);
  }

  static async getResourceUsage(userId: string) {
    await reconcileTimeBoundEntitlement(userId);
    const [quota] = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId));
    if (!quota) return null;

    const servers = await db
      .select({
        cpuCores: serverConfigs.cpuCores,
        ramMb: serverConfigs.ramMb,
        storageGb: serverConfigs.storageGb,
      })
      .from(gameServers)
      .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .where(and(eq(gameServers.userId, userId), ne(gameServers.currentState, "deleted")));
    const used = servers.reduce<ResourceAllocation>(
      (total, server) => ({
        servers: total.servers + 1,
        cpu: total.cpu + (Number(server.cpuCores) || 0),
        ramMb: total.ramMb + (server.ramMb || 0),
        storageGb: total.storageGb + (server.storageGb || 0),
      }),
      { servers: 0, cpu: 0, ramMb: 0, storageGb: 0 },
    );
    const limits: QuotaLimits = {
      serversLimit: quota.serversLimit,
      cpuLimit: Number(quota.cpuLimit),
      ramLimitMb: quota.ramLimitMb,
      storageLimitGb: quota.storageLimitGb,
    };
    const backupUsage = await readBackupUsage(userId);

    return {
      plan: quota.plan,
      cpuLimit: quota.cpuLimit,
      cpuUsed: String(used.cpu),
      ramLimitMb: quota.ramLimitMb,
      ramUsedMb: used.ramMb,
      storageLimitGb: quota.storageLimitGb,
      storageUsedGb: used.storageGb,
      serversLimit: quota.serversLimit,
      serversUsed: used.servers,
      backupsLimit: backupUsage?.backupsLimit ?? quota.backupsLimit,
      backupsUsed: backupUsage?.backupsUsed ?? 0,
      overQuota:
        allocationViolations(limits, used).length > 0 ||
        (backupUsage?.backupsUsed ?? 0) > quota.backupsLimit,
      deploymentHeadroomReserved: await headroomHeldByUser(userId),
    };
  }
}
