import { type DeploymentState, type DeploymentView, PRE_CUTOVER_STATES } from "@farlands/contracts";
import { deploymentStateEvents, deployments, serverRuleHeads } from "@repo/db";
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";

import { db } from "../../db";

export type QueueStatus = "waiting" | "running" | "complete";

export type DeploymentRecord = DeploymentView & {
  userId: string;
  namespace: string | null;
  liveDeployment: string | null;
  liveService: string | null;
  livePvc: string | null;
  liveProxyTarget: string | null;
  candidateService: string | null;
  candidatePvc: string | null;
  sourcePlayers: string[];
  lobbyPlayers: string[];
  sourcePlayerCount: number;
  presyncCompletedAt: string | null;
  savesDisabled: boolean;
  candidateHealthy: boolean;
  routeSwitched: boolean;
  abortRequestedAt: string | null;
  approvedContentDigest: string;
  artifactUrl: string | null;
  artifactDigest: string | null;
  artifactRuntimeVersion: string | null;
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
    | "livePvc"
    | "liveProxyTarget"
    | "candidateService"
    | "candidatePvc"
    | "sourcePlayers"
    | "lobbyPlayers"
    | "sourcePlayerCount"
    | "presyncCompletedAt"
    | "savesDisabled"
    | "candidateHealthy"
    | "routeSwitched"
    | "abortRequestedAt"
    | "artifactUrl"
    | "artifactDigest"
    | "artifactRuntimeVersion"
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
    expectedStates?: readonly DeploymentState[],
    allowAbortRequested?: boolean,
  ): Promise<DeploymentRecord>;
  requestAbort(id: string, requestedAt: Date): Promise<DeploymentRecord | null>;
  queuePosition(id: string): Promise<number | null>;
  claimNext(workerId: string, maxConcurrent: number, leaseMs: number): Promise<string | null>;
  claimExpired(workerId: string, leaseMs: number): Promise<DeploymentRecord | null>;
  renewLease(id: string, workerId: string, leaseMs: number): Promise<boolean>;
  takeoverExpiredLease(id: string, workerId: string, leaseMs: number, now: Date): Promise<boolean>;
  completeQueue(id: string): Promise<void>;
  listRecoverable(): Promise<DeploymentRecord[]>;
  listPendingCandidateCleanup(): Promise<DeploymentRecord[]>;
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
    livePvc: row.livePvc,
    liveProxyTarget: row.liveProxyTarget,
    candidateService: row.candidateService,
    candidatePvc: row.candidatePvc,
    sourcePlayers: row.sourcePlayers,
    lobbyPlayers: row.lobbyPlayers,
    sourcePlayerCount: row.sourcePlayerCount,
    presyncCompletedAt: row.presyncCompletedAt?.toISOString() ?? null,
    savesDisabled: row.savesDisabled,
    candidateHealthy: row.candidateHealthy,
    routeSwitched: row.routeSwitched,
    abortRequestedAt: row.abortRequestedAt?.toISOString() ?? null,
    approvedContentDigest: row.approvedContentDigest,
    artifactUrl: row.artifactUrl,
    artifactDigest: row.artifactDigest,
    artifactRuntimeVersion: row.artifactRuntimeVersion,
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
    artifactUrl: record.artifactUrl,
    artifactDigest: record.artifactDigest,
    artifactRuntimeVersion: record.artifactRuntimeVersion,
    initiatedBy: record.initiatedBy,
    namespace: record.namespace,
    liveDeployment: record.liveDeployment,
    liveService: record.liveService,
    livePvc: record.livePvc,
    liveProxyTarget: record.liveProxyTarget,
    candidateService: record.candidateService,
    candidatePvc: record.candidatePvc,
    sourcePlayers: record.sourcePlayers,
    lobbyPlayers: record.lobbyPlayers,
    sourcePlayerCount: record.sourcePlayerCount,
    presyncCompletedAt: record.presyncCompletedAt ? new Date(record.presyncCompletedAt) : null,
    savesDisabled: record.savesDisabled,
    candidateHealthy: record.candidateHealthy,
    routeSwitched: record.routeSwitched,
    abortRequestedAt: record.abortRequestedAt ? new Date(record.abortRequestedAt) : null,
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
    ...(patch.livePvc !== undefined ? { livePvc: patch.livePvc } : {}),
    ...(patch.liveProxyTarget !== undefined ? { liveProxyTarget: patch.liveProxyTarget } : {}),
    ...(patch.candidateService !== undefined ? { candidateService: patch.candidateService } : {}),
    ...(patch.candidatePvc !== undefined ? { candidatePvc: patch.candidatePvc } : {}),
    ...(patch.sourcePlayers !== undefined ? { sourcePlayers: patch.sourcePlayers } : {}),
    ...(patch.lobbyPlayers !== undefined ? { lobbyPlayers: patch.lobbyPlayers } : {}),
    ...(patch.sourcePlayerCount !== undefined
      ? { sourcePlayerCount: patch.sourcePlayerCount }
      : {}),
    ...(patch.presyncCompletedAt !== undefined
      ? {
          presyncCompletedAt: patch.presyncCompletedAt ? new Date(patch.presyncCompletedAt) : null,
        }
      : {}),
    ...(patch.savesDisabled !== undefined ? { savesDisabled: patch.savesDisabled } : {}),
    ...(patch.candidateHealthy !== undefined ? { candidateHealthy: patch.candidateHealthy } : {}),
    ...(patch.routeSwitched !== undefined ? { routeSwitched: patch.routeSwitched } : {}),
    ...(patch.abortRequestedAt !== undefined
      ? {
          abortRequestedAt: patch.abortRequestedAt ? new Date(patch.abortRequestedAt) : null,
        }
      : {}),
    ...(patch.artifactUrl !== undefined ? { artifactUrl: patch.artifactUrl } : {}),
    ...(patch.artifactDigest !== undefined ? { artifactDigest: patch.artifactDigest } : {}),
    ...(patch.artifactRuntimeVersion !== undefined
      ? { artifactRuntimeVersion: patch.artifactRuntimeVersion }
      : {}),
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
    expectedStates?: readonly DeploymentState[],
    allowAbortRequested = false,
  ): Promise<DeploymentRecord> {
    return db.transaction(async (tx) => {
      const conditions = [eq(deployments.id, id)];
      if (expectedStates?.length) conditions.push(inArray(deployments.state, [...expectedStates]));
      if (!allowAbortRequested) conditions.push(isNull(deployments.abortRequestedAt));
      const [updated] = await tx
        .update(deployments)
        .set({ state, ...updateValues(patch), updatedAt: sql`now()` })
        .where(and(...conditions))
        .returning();
      if (!updated) {
        const [current] = await tx.select().from(deployments).where(eq(deployments.id, id));
        if (!current) throw new Error(`Unknown deployment ${id}`);
        throw new DeploymentInterruptedError(id, current.state as DeploymentState);
      }
      await tx.insert(deploymentStateEvents).values({ deploymentId: id, state, detail });
      return toRecord(updated);
    });
  }

  async requestAbort(id: string, requestedAt: Date): Promise<DeploymentRecord | null> {
    const [updated] = await db
      .update(deployments)
      .set({ abortRequestedAt: requestedAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(deployments.id, id),
          inArray(deployments.state, [...PRE_CUTOVER_STATES]),
          isNull(deployments.abortRequestedAt),
        ),
      )
      .returning();
    if (updated) return toRecord(updated);
    const current = await db.query.deployments.findFirst({ where: eq(deployments.id, id) });
    return current ? toRecord(current) : null;
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

  async takeoverExpiredLease(
    id: string,
    workerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<boolean> {
    const claimed = await db
      .update(deployments)
      .set({
        workerId,
        leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(deployments.id, id),
          eq(deployments.queueStatus, "running"),
          sql`${deployments.leaseExpiresAt} <= ${now}`,
        ),
      )
      .returning({ id: deployments.id });
    return claimed.length === 1;
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

  async listPendingCandidateCleanup(): Promise<DeploymentRecord[]> {
    const rows = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.queueStatus, "complete"),
          inArray(deployments.state, ["aborted", "failed"]),
          isNotNull(deployments.candidatePod),
          isNotNull(deployments.namespace),
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
      const [current] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, input.deploymentId))
        .for("update");
      if (!current) throw new Error(`Unknown deployment ${input.deploymentId}`);
      if (current.serverId !== input.serverId) {
        throw new Error("Cutover server does not match the deployment target");
      }
      if (
        current.toVersion !== input.version ||
        current.approvedContentDigest.toLowerCase() !== input.digest.toLowerCase() ||
        current.artifactDigest?.toLowerCase() !== input.digest.toLowerCase()
      ) {
        throw new Error("Cutover head must match the deployment's verified artifact exactly");
      }
      if (current.state === "draining" || current.state === "idle") return toRecord(current);
      if (
        current.state !== "cutover" ||
        !current.routeSwitched ||
        current.lobbyPlayers.length > 0
      ) {
        throw new Error("Cutover cannot commit before route and roster handoff complete");
      }

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
        WHERE ${serverRuleHeads.currentDeploymentId} IS DISTINCT FROM excluded.current_deployment_id
      `);
      const [updated] = await tx
        .update(deployments)
        .set({ state: "draining", updatedAt: sql`now()` })
        .where(
          and(
            eq(deployments.id, input.deploymentId),
            eq(deployments.state, "cutover"),
            eq(deployments.queueStatus, "running"),
            eq(deployments.workerId, input.workerId),
            sql`${deployments.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning();
      if (!updated) throw new Error(`Deployment ${input.deploymentId} lost its cutover lease`);
      await tx.insert(deploymentStateEvents).values({
        deploymentId: input.deploymentId,
        state: "draining",
        detail: "candidate B is authoritative; retaining A for rollback",
      });
      return toRecord(updated);
    });
  }
}

export class MemoryDeploymentStore implements DeploymentStore {
  readonly records = new Map<string, DeploymentRecord>();
  readonly events: Array<{ deploymentId: string; state: DeploymentState; detail: string | null }> =
    [];
  readonly heads = new Map<string, RuleHead>();
  readonly headDeploymentIds = new Map<string, string>();
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
    expectedStates?: readonly DeploymentState[],
    allowAbortRequested = false,
  ): Promise<DeploymentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown deployment ${id}`);
    if (
      (expectedStates?.length && !expectedStates.includes(record.state)) ||
      (!allowAbortRequested && record.abortRequestedAt)
    ) {
      throw new DeploymentInterruptedError(id, record.state);
    }
    const updated = { ...record, ...patch, state };
    this.records.set(id, updated);
    this.events.push({ deploymentId: id, state, detail });
    return { ...updated };
  }

  async requestAbort(id: string, requestedAt: Date): Promise<DeploymentRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (
      PRE_CUTOVER_STATES.includes(record.state as (typeof PRE_CUTOVER_STATES)[number]) &&
      !record.abortRequestedAt
    ) {
      record.abortRequestedAt = requestedAt.toISOString();
    }
    return { ...record };
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

  async takeoverExpiredLease(
    id: string,
    workerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (
      record?.queueStatus !== "running" ||
      !record.leaseExpiresAt ||
      new Date(record.leaseExpiresAt) > now
    ) {
      return false;
    }
    record.workerId = workerId;
    record.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
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

  async listPendingCandidateCleanup(): Promise<DeploymentRecord[]> {
    return [...this.records.values()]
      .filter(
        (row) =>
          row.queueStatus === "complete" &&
          (row.state === "aborted" || row.state === "failed") &&
          row.candidatePod !== null &&
          row.namespace !== null,
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
    const record = this.records.get(input.deploymentId);
    if (!record) throw new Error(`Unknown deployment ${input.deploymentId}`);
    if (record.serverId !== input.serverId) {
      throw new Error("Cutover server does not match the deployment target");
    }
    if (
      record.toVersion !== input.version ||
      record.approvedContentDigest.toLowerCase() !== input.digest.toLowerCase() ||
      record.artifactDigest?.toLowerCase() !== input.digest.toLowerCase()
    ) {
      throw new Error("Cutover head must match the deployment's verified artifact exactly");
    }
    if (record.state === "draining" || record.state === "idle") return { ...record };
    if (record.state !== "cutover" || !record.routeSwitched || record.lobbyPlayers.length > 0) {
      throw new Error("Cutover cannot commit before route and roster handoff complete");
    }
    if (
      record.queueStatus !== "running" ||
      record.workerId !== input.workerId ||
      record.leaseExpiresAt === null ||
      new Date(record.leaseExpiresAt) <= this.now()
    ) {
      throw new Error(`Deployment ${input.deploymentId} lost its cutover lease`);
    }
    if (this.headDeploymentIds.get(input.serverId) !== input.deploymentId) {
      const current = this.heads.get(input.serverId);
      this.heads.set(input.serverId, {
        currentVersion: input.version,
        currentDigest: input.digest,
        previousVersion: current?.currentVersion ?? null,
        previousDigest: current?.currentDigest ?? null,
      });
      this.headDeploymentIds.set(input.serverId, input.deploymentId);
    }
    record.state = "draining";
    this.events.push({
      deploymentId: input.deploymentId,
      state: "draining",
      detail: "candidate B is authoritative; retaining A for rollback",
    });
    return { ...record };
  }
}

export const deploymentStore: DeploymentStore = new DrizzleDeploymentStore();

export class DeploymentInterruptedError extends Error {
  constructor(
    readonly deploymentId: string,
    readonly currentState: DeploymentState,
  ) {
    super(`Deployment ${deploymentId} was interrupted in state ${currentState}`);
    this.name = "DeploymentInterruptedError";
  }
}
