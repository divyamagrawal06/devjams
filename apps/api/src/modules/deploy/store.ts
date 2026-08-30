import type { DeploymentState, DeploymentView } from "@farlands/contracts";
import { deploymentStateEvents, deployments, serverRuleHeads } from "@repo/db";
import { and, asc, count, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import { db } from "../../db";

export type QueueStatus = "waiting" | "running" | "complete";

export type DeploymentRecord = DeploymentView & {
  userId: string;
  namespace: string | null;
  liveDeployment: string | null;
  liveService: string | null;
  approvedContentDigest: string;
  initiatedBy: string;
  queueStatus: QueueStatus;
  queueSequence: number;
  workerId: string | null;
  leaseExpiresAt: string | null;
};

export type DeploymentPatch = Partial<
  Pick<
    DeploymentRecord,
    | "candidatePod"
    | "snapshotId"
    | "namespace"
    | "liveDeployment"
    | "liveService"
    | "error"
    | "finishedAt"
    | "workerId"
    | "leaseExpiresAt"
    | "queueStatus"
  >
>;

export type RuleHead = {
  currentVersion: string | null;
  currentDigest: string | null;
  previousVersion: string | null;
  previousDigest: string | null;
};

export interface DeploymentStore {
  create(record: Omit<DeploymentRecord, "queueSequence">): Promise<DeploymentRecord>;
  find(id: string): Promise<DeploymentRecord | null>;
  transition(
    id: string,
    state: DeploymentState,
    patch?: DeploymentPatch,
    detail?: string | null,
  ): Promise<DeploymentRecord>;
  queuePosition(id: string): Promise<number | null>;
  claimNext(workerId: string, maxConcurrent: number, leaseMs: number): Promise<string | null>;
  claimExpired(workerId: string, leaseMs: number): Promise<DeploymentRecord | null>;
  renewLease(id: string, workerId: string, leaseMs: number): Promise<boolean>;
  completeQueue(id: string): Promise<void>;
  listRecoverable(): Promise<DeploymentRecord[]>;
  findRuleHead(serverId: string): Promise<RuleHead | null>;
  commitCutover(input: {
    serverId: string;
    deploymentId: string;
    version: string;
    digest: string;
    workerId: string;
  }): Promise<DeploymentRecord>;
}

type DeploymentRow = typeof deployments.$inferSelect;

function toRecord(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    serverId: row.serverId,
    state: row.state as DeploymentState,
    queuePosition: null,
    candidatePod: row.candidatePod,
    snapshotId: row.snapshotId,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    userId: row.userId,
    namespace: row.namespace,
    liveDeployment: row.liveDeployment,
    liveService: row.liveService,
    approvedContentDigest: row.approvedContentDigest,
    initiatedBy: row.initiatedBy,
    queueStatus: row.queueStatus as QueueStatus,
    queueSequence: row.queueSequence,
    workerId: row.workerId,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
  };
}

function insertValues(record: Omit<DeploymentRecord, "queueSequence">) {
  return {
    id: record.id,
    serverId: record.serverId,
    userId: record.userId,
    state: record.state,
    queueStatus: record.queueStatus,
    workerId: record.workerId,
    leaseExpiresAt: record.leaseExpiresAt ? new Date(record.leaseExpiresAt) : null,
    candidatePod: record.candidatePod,
    snapshotId: record.snapshotId,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion ?? "",
    approvedContentDigest: record.approvedContentDigest,
    initiatedBy: record.initiatedBy,
    namespace: record.namespace,
    liveDeployment: record.liveDeployment,
    liveService: record.liveService,
    error: record.error,
    startedAt: new Date(record.startedAt),
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
  };
}

function updateValues(patch: DeploymentPatch) {
  return {
    ...(patch.candidatePod !== undefined ? { candidatePod: patch.candidatePod } : {}),
    ...(patch.snapshotId !== undefined ? { snapshotId: patch.snapshotId } : {}),
    ...(patch.namespace !== undefined ? { namespace: patch.namespace } : {}),
    ...(patch.liveDeployment !== undefined ? { liveDeployment: patch.liveDeployment } : {}),
    ...(patch.liveService !== undefined ? { liveService: patch.liveService } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.finishedAt !== undefined
      ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null }
      : {}),
    ...(patch.workerId !== undefined ? { workerId: patch.workerId } : {}),
    ...(patch.leaseExpiresAt !== undefined
      ? { leaseExpiresAt: patch.leaseExpiresAt ? new Date(patch.leaseExpiresAt) : null }
      : {}),
    ...(patch.queueStatus !== undefined ? { queueStatus: patch.queueStatus } : {}),
  };
}

export class DrizzleDeploymentStore implements DeploymentStore {
  async create(record: Omit<DeploymentRecord, "queueSequence">): Promise<DeploymentRecord> {
    return db.transaction(async (tx) => {
      const [created] = await tx.insert(deployments).values(insertValues(record)).returning();
      if (!created) throw new Error("Deployment insert did not return a row");
      await tx.insert(deploymentStateEvents).values({
        deploymentId: created.id,
        state: created.state,
        detail: "enqueued",
      });
      return toRecord(created);
    });
  }

  async find(id: string): Promise<DeploymentRecord | null> {
    const row = await db.query.deployments.findFirst({ where: eq(deployments.id, id) });
    if (!row) return null;
    const record = toRecord(row);
    record.queuePosition = await this.queuePosition(id);
    return record;
  }

  async transition(
    id: string,
    state: DeploymentState,
    patch: DeploymentPatch = {},
    detail: string | null = null,
  ): Promise<DeploymentRecord> {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(deployments)
        .set({ state, ...updateValues(patch), updatedAt: sql`now()` })
        .where(eq(deployments.id, id))
        .returning();
      if (!updated) throw new Error(`Unknown deployment ${id}`);
      await tx.insert(deploymentStateEvents).values({ deploymentId: id, state, detail });
      return toRecord(updated);
    });
  }

  async queuePosition(id: string): Promise<number | null> {
    const [target] = await db
      .select({ queueStatus: deployments.queueStatus, sequence: deployments.queueSequence })
      .from(deployments)
      .where(eq(deployments.id, id));
    if (!target || target.queueStatus === "complete") return null;
    if (target.queueStatus === "running") return 0;
    const [ahead] = await db
      .select({ value: count() })
      .from(deployments)
      .where(
        and(eq(deployments.queueStatus, "waiting"), lt(deployments.queueSequence, target.sequence)),
      );
    return Number(ahead?.value ?? 0) + 1;
  }

  async claimNext(
    workerId: string,
    maxConcurrent: number,
    leaseMs: number,
  ): Promise<string | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1835103842)`);
      const [active] = await tx
        .select({ value: count() })
        .from(deployments)
        .where(eq(deployments.queueStatus, "running"));
      if (Number(active?.value ?? 0) >= maxConcurrent) return null;

      const [candidate] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.queueStatus, "waiting"))
        .orderBy(asc(deployments.queueSequence))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;

      const [claimed] = await tx
        .update(deployments)
        .set({
          queueStatus: "running",
          workerId,
          leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(deployments.id, candidate.id), eq(deployments.queueStatus, "waiting")))
        .returning({ id: deployments.id });
      return claimed?.id ?? null;
    });
  }

  async claimExpired(workerId: string, leaseMs: number): Promise<DeploymentRecord | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1835103842)`);
      const [candidate] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.queueStatus, "running"),
            sql`(${deployments.leaseExpiresAt} IS NULL OR ${deployments.leaseExpiresAt} <= now())`,
          ),
        )
        .orderBy(asc(deployments.queueSequence))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;

      const [claimed] = await tx
        .update(deployments)
        .set({
          workerId,
          leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(deployments.id, candidate.id),
            eq(deployments.queueStatus, "running"),
            sql`(${deployments.leaseExpiresAt} IS NULL OR ${deployments.leaseExpiresAt} <= now())`,
          ),
        )
        .returning();
      return claimed ? toRecord(claimed) : null;
    });
  }

  async completeQueue(id: string): Promise<void> {
    await db
      .update(deployments)
      .set({
        queueStatus: "complete",
        workerId: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(deployments.id, id));
  }

  async renewLease(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const renewed = await db
      .update(deployments)
      .set({
        leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(deployments.id, id),
          eq(deployments.queueStatus, "running"),
          eq(deployments.workerId, workerId),
          sql`${deployments.leaseExpiresAt} > now()`,
        ),
      )
      .returning({ id: deployments.id });
    return renewed.length === 1;
  }

  async listRecoverable(): Promise<DeploymentRecord[]> {
    const rows = await db
      .select()
      .from(deployments)
      .where(
        and(
          notInArray(deployments.state, ["idle", "aborted", "failed"]),
          inArray(deployments.queueStatus, ["waiting", "running"]),
        ),
      )
      .orderBy(asc(deployments.queueSequence));
    return rows.map(toRecord);
  }

  async findRuleHead(serverId: string): Promise<RuleHead | null> {
    const row = await db.query.serverRuleHeads.findFirst({
      where: eq(serverRuleHeads.serverId, serverId),
    });
    return row
      ? {
          currentVersion: row.currentVersion,
          currentDigest: row.currentDigest,
          previousVersion: row.previousVersion,
          previousDigest: row.previousDigest,
        }
      : null;
  }

  async commitCutover(input: {
    serverId: string;
    deploymentId: string;
    version: string;
    digest: string;
    workerId: string;
  }): Promise<DeploymentRecord> {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(deployments)
        .set({ state: "draining", updatedAt: sql`now()` })
        .where(
          and(
            eq(deployments.id, input.deploymentId),
            eq(deployments.state, "verifying"),
            eq(deployments.queueStatus, "running"),
            eq(deployments.workerId, input.workerId),
            sql`${deployments.leaseExpiresAt} > now()`,
          ),
        )
        .returning();
      if (!updated) throw new Error(`Deployment ${input.deploymentId} lost its cutover lease`);

      await tx.insert(deploymentStateEvents).values({
        deploymentId: input.deploymentId,
        state: "draining",
        detail: "cutover committed",
      });
      await tx.execute(sql`
        INSERT INTO ${serverRuleHeads} (
          server_id, current_version, current_digest, previous_version,
          previous_digest, current_deployment_id, updated_at
        ) VALUES (
          ${input.serverId}, ${input.version}, ${input.digest}, NULL,
          NULL, ${input.deploymentId}, now()
        )
        ON CONFLICT (server_id) DO UPDATE SET
          previous_version = ${serverRuleHeads.currentVersion},
          previous_digest = ${serverRuleHeads.currentDigest},
          current_version = excluded.current_version,
          current_digest = excluded.current_digest,
          current_deployment_id = excluded.current_deployment_id,
          updated_at = now()
      `);
      return toRecord(updated);
    });
  }
}

export class MemoryDeploymentStore implements DeploymentStore {
  readonly records = new Map<string, DeploymentRecord>();
  readonly events: Array<{ deploymentId: string; state: DeploymentState; detail: string | null }> =
    [];
  readonly heads = new Map<string, RuleHead>();
  private nextSequence = 1;
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async create(record: Omit<DeploymentRecord, "queueSequence">): Promise<DeploymentRecord> {
    const created = { ...record, queueSequence: this.nextSequence++ };
    this.records.set(created.id, created);
    this.events.push({ deploymentId: created.id, state: created.state, detail: "enqueued" });
    return { ...created };
  }

  async find(id: string): Promise<DeploymentRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    return { ...record, queuePosition: await this.queuePosition(id) };
  }

  async transition(
    id: string,
    state: DeploymentState,
    patch: DeploymentPatch = {},
    detail: string | null = null,
  ): Promise<DeploymentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown deployment ${id}`);
    const updated = { ...record, ...patch, state };
    this.records.set(id, updated);
    this.events.push({ deploymentId: id, state, detail });
    return { ...updated };
  }

  async queuePosition(id: string): Promise<number | null> {
    const target = this.records.get(id);
    if (!target || target.queueStatus === "complete") return null;
    if (target.queueStatus === "running") return 0;
    return (
      [...this.records.values()].filter(
        (row) => row.queueStatus === "waiting" && row.queueSequence < target.queueSequence,
      ).length + 1
    );
  }

  async claimNext(
    workerId: string,
    maxConcurrent: number,
    leaseMs: number,
  ): Promise<string | null> {
    const now = this.now();
    const active = [...this.records.values()].filter((row) => row.queueStatus === "running");
    if (active.length >= maxConcurrent) return null;
    const candidate = [...this.records.values()]
      .filter((row) => row.queueStatus === "waiting")
      .sort((a, b) => a.queueSequence - b.queueSequence)[0];
    if (!candidate) return null;
    candidate.queueStatus = "running";
    candidate.workerId = workerId;
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return candidate.id;
  }

  async claimExpired(workerId: string, leaseMs: number): Promise<DeploymentRecord | null> {
    const now = this.now();
    const candidate = [...this.records.values()]
      .filter(
        (row) =>
          row.queueStatus === "running" &&
          (row.leaseExpiresAt === null || new Date(row.leaseExpiresAt) <= now),
      )
      .sort((a, b) => a.queueSequence - b.queueSequence)[0];
    if (!candidate) return null;
    candidate.workerId = workerId;
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return { ...candidate };
  }

  async completeQueue(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.queueStatus = "complete";
    record.workerId = null;
    record.leaseExpiresAt = null;
  }

  async renewLease(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const record = this.records.get(id);
    if (
      record?.queueStatus !== "running" ||
      record.workerId !== workerId ||
      record.leaseExpiresAt === null ||
      new Date(record.leaseExpiresAt) <= this.now()
    ) {
      return false;
    }
    record.leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
    return true;
  }

  async listRecoverable(): Promise<DeploymentRecord[]> {
    return [...this.records.values()]
      .filter(
        (row) =>
          !(["idle", "aborted", "failed"] as DeploymentState[]).includes(row.state) &&
          row.queueStatus !== "complete",
      )
      .sort((a, b) => a.queueSequence - b.queueSequence)
      .map((row) => ({ ...row }));
  }

  async findRuleHead(serverId: string): Promise<RuleHead | null> {
    return this.heads.get(serverId) ?? null;
  }

  async commitCutover(input: {
    serverId: string;
    deploymentId: string;
    version: string;
    digest: string;
    workerId: string;
  }): Promise<DeploymentRecord> {
    const deployment = this.records.get(input.deploymentId);
    if (
      deployment?.state !== "verifying" ||
      deployment.queueStatus !== "running" ||
      deployment.workerId !== input.workerId ||
      deployment.leaseExpiresAt === null ||
      new Date(deployment.leaseExpiresAt) <= this.now()
    ) {
      throw new Error(`Deployment ${input.deploymentId} lost its cutover lease`);
    }

    deployment.state = "draining";
    this.events.push({
      deploymentId: input.deploymentId,
      state: "draining",
      detail: "cutover committed",
    });
    const current = this.heads.get(input.serverId);
    this.heads.set(input.serverId, {
      currentVersion: input.version,
      currentDigest: input.digest,
      previousVersion: current?.currentVersion ?? null,
      previousDigest: current?.currentDigest ?? null,
    });
    return { ...deployment };
  }
}

export const deploymentStore: DeploymentStore = new DrizzleDeploymentStore();
