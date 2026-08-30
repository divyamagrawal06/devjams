import { randomUUID } from "node:crypto";
import { digestsEqual } from "@farlands/contracts";
import { buildRuleJar, validatePluginBuilderBody } from "@farlands/plugin-builder";
import {
  changeEnvelopes,
  controlPlaneEvents,
  deployments,
  gameServers,
  ruleArtifacts,
  ruleSetVersions,
  serverRuleAssignments,
  serverRuleHeads,
  serverRules,
} from "@repo/db";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "../../db";
import { deployRulesApprovalClaim, operationApprovalService } from "../agent/approvals";
import { admitQueuedDeployments, queuedDeploymentRecord } from "../deploy/controller";
import { createDeploymentRecordInTransaction } from "../deploy/store";
import { RulesService } from "../rules/service";
import { describeDocumentChange } from "./diff";
import type { ChangeDraftInput } from "./model";

export type ChangeStatus = "pending_review" | "approved" | "rejected";

export class ChangeOperationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChangeOperationError";
  }
}

type ChangeRow = typeof changeEnvelopes.$inferSelect;

function changeId(): string {
  return `chg_${randomUUID().replaceAll("-", "")}`;
}

function ruleVersionId(): string {
  return `rsv_${randomUUID().replaceAll("-", "")}`;
}

function artifactId(): string {
  return `art_${randomUUID().replaceAll("-", "")}`;
}

function deterministicDeploymentId(id: string): string {
  return `dep_${id.slice("chg_".length)}`;
}

export function reviewedDigestFromIfMatch(value: string | undefined): string | null {
  if (!value || value === "*" || value.startsWith("W/")) return null;
  const digest = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function publicEnvelope(
  row: ChangeRow,
  extra: {
    serverName: string;
    deploymentState: string | null;
    deploymentError: string | null;
    deploymentStartedAt: Date | null;
    deploymentFinishedAt: Date | null;
  },
) {
  return {
    id: row.id,
    serverId: row.serverId,
    serverName: extra.serverName,
    ruleVersionId: row.ruleVersionId,
    ruleVersion: row.ruleVersion,
    title: row.title,
    rationale: row.rationale,
    source: row.source,
    document: row.document,
    contentDigest: row.contentDigest,
    artifactDigest: row.artifactDigest,
    runtimeDigest: row.runtimeDigest,
    runtimeMinecraftVersion: row.runtimeMinecraftVersion,
    status: row.status as ChangeStatus,
    reviewedArtifactDigest: row.reviewedArtifactDigest,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    deploymentId: row.deploymentId,
    deploymentState: extra.deploymentState,
    deploymentError: extra.deploymentError,
    deploymentStartedAt: extra.deploymentStartedAt?.toISOString() ?? null,
    deploymentFinishedAt: extra.deploymentFinishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const envelopeSelection = {
  envelope: changeEnvelopes,
  serverName: gameServers.name,
  deploymentState: deployments.state,
  deploymentError: deployments.error,
  deploymentStartedAt: deployments.startedAt,
  deploymentFinishedAt: deployments.finishedAt,
};

async function envelopeById(userId: string, id: string) {
  const [result] = await db
    .select(envelopeSelection)
    .from(changeEnvelopes)
    .innerJoin(gameServers, eq(gameServers.id, changeEnvelopes.serverId))
    .leftJoin(deployments, eq(deployments.id, changeEnvelopes.deploymentId))
    .where(and(eq(changeEnvelopes.id, id), eq(changeEnvelopes.userId, userId)))
    .limit(1);
  return result ?? null;
}

export abstract class ChangeService {
  static async list(userId: string, status?: ChangeStatus) {
    const conditions = [eq(changeEnvelopes.userId, userId)];
    if (status) conditions.push(eq(changeEnvelopes.status, status));
    const rows = await db
      .select(envelopeSelection)
      .from(changeEnvelopes)
      .innerJoin(gameServers, eq(gameServers.id, changeEnvelopes.serverId))
      .leftJoin(deployments, eq(deployments.id, changeEnvelopes.deploymentId))
      .where(and(...conditions))
      .orderBy(desc(changeEnvelopes.createdAt));
    return rows.map((row) => publicEnvelope(row.envelope, row));
  }

  static async get(userId: string, id: string) {
    const result = await envelopeById(userId, id);
    if (!result) throw new ChangeOperationError(404, "Change not found");

    const [head] = await db
      .select({ currentVersion: serverRuleHeads.currentVersion })
      .from(serverRuleHeads)
      .where(eq(serverRuleHeads.serverId, result.envelope.serverId))
      .limit(1);
    const liveVersion =
      head?.currentVersion && /^\d+$/.test(head.currentVersion)
        ? Number(head.currentVersion)
        : null;
    const [previous] = liveVersion
      ? await db
          .select({ document: changeEnvelopes.document })
          .from(changeEnvelopes)
          .where(
            and(
              eq(changeEnvelopes.serverId, result.envelope.serverId),
              eq(changeEnvelopes.ruleVersion, liveVersion),
              inArray(changeEnvelopes.status, ["approved"]),
            ),
          )
          .limit(1)
      : [];

    const events = await db
      .select()
      .from(controlPlaneEvents)
      .where(eq(controlPlaneEvents.serverId, result.envelope.serverId))
      .orderBy(desc(controlPlaneEvents.id))
      .limit(500);
    const timeline = events
      .reverse()
      .filter((event) => {
        const change = event.data.change_id;
        const deployment = event.data.deployment_id;
        return (
          change === result.envelope.id ||
          (result.envelope.deploymentId !== null && deployment === result.envelope.deploymentId)
        );
      })
      .map((event) => ({
        id: String(event.id),
        type: event.type,
        data: event.data,
        createdAt: event.createdAt.toISOString(),
      }));

    return {
      ...publicEnvelope(result.envelope, result),
      diff: describeDocumentChange(previous?.document ?? null, result.envelope.document),
      timeline,
    };
  }

  static async create(userId: string, input: ChangeDraftInput) {
    const [server] = await db
      .select({ id: gameServers.id, name: gameServers.name, game: gameServers.game })
      .from(gameServers)
      .where(and(eq(gameServers.id, input.serverId), eq(gameServers.userId, userId)))
      .limit(1);
    if (!server) throw new ChangeOperationError(404, "Server not found");
    if (server.game !== "minecraft") {
      throw new ChangeOperationError(
        409,
        "Live rule changes are currently available only for Minecraft workloads.",
      );
    }

    const validation = validatePluginBuilderBody(input.document);
    if (!validation.ok) throw new ChangeOperationError(400, validation.error);
    const document = JSON.parse(JSON.stringify(validation.value)) as Record<string, unknown>;

    let built: Awaited<ReturnType<typeof buildRuleJar>>;
    try {
      built = await buildRuleJar(document);
    } catch (error) {
      console.error("Rule artifact build failed", {
        message: error instanceof Error ? error.message : "Unknown artifact build error",
      });
      throw new ChangeOperationError(
        503,
        "The immutable rule artifact could not be built. Try again after the builder recovers.",
      );
    }

    const createdId = changeId();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`change:${server.id}`}))`);
      const assigned = await tx
        .select({
          ruleSetId: serverRules.id,
          createdBy: serverRules.createdBy,
          gameType: serverRules.gameType,
        })
        .from(serverRuleAssignments)
        .innerJoin(serverRules, eq(serverRules.id, serverRuleAssignments.ruleId))
        .where(
          and(
            eq(serverRuleAssignments.serverId, server.id),
            eq(serverRuleAssignments.isActive, true),
          ),
        );
      if (assigned.length > 1) {
        throw new ChangeOperationError(
          409,
          "This server has multiple active rule sets; resolve that conflict before drafting.",
        );
      }

      let ruleSetId = assigned[0]?.ruleSetId;
      if (
        assigned[0] &&
        (assigned[0].createdBy !== userId || assigned[0].gameType !== "minecraft")
      ) {
        throw new ChangeOperationError(409, "The active rule set is not owned by this account.");
      }
      if (!ruleSetId) {
        ruleSetId = randomUUID();
        await tx.insert(serverRules).values({
          id: ruleSetId,
          createdBy: userId,
          name: `${server.name} live rules`.slice(0, 120),
          description: "Immutable live rules reviewed through the change queue.",
          gameType: "minecraft",
          jsonUrl: built.jsonUrl,
          version: "1",
        });
        await tx.insert(serverRuleAssignments).values({
          id: randomUUID(),
          serverId: server.id,
          ruleId: ruleSetId,
          isActive: true,
        });
      }

      const [duplicate] = await tx
        .select({ id: ruleSetVersions.id })
        .from(ruleSetVersions)
        .where(
          and(
            eq(ruleSetVersions.ruleSetId, ruleSetId),
            eq(ruleSetVersions.contentDigest, built.contentDigest),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ChangeOperationError(
          409,
          "This exact rule document already has a review record.",
        );
      }

      const [latest] = await tx
        .select({ version: ruleSetVersions.version })
        .from(ruleSetVersions)
        .where(eq(ruleSetVersions.ruleSetId, ruleSetId))
        .orderBy(desc(ruleSetVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const createdRuleVersionId = ruleVersionId();
      await tx.insert(ruleSetVersions).values({
        id: createdRuleVersionId,
        ruleSetId,
        version,
        jsonUrl: built.jsonUrl,
        contentDigest: built.contentDigest,
        source: "form",
        provenanceRef: createdId,
        createdBy: userId,
      });
      await tx.insert(ruleArtifacts).values({
        id: artifactId(),
        ruleVersionId: createdRuleVersionId,
        artifactUrl: built.jarUrl,
        artifactDigest: built.artifactDigest,
        runtimeDigest: built.runtimeDigest,
        runtimeMinecraftVersion: built.runtimeMinecraftVersion,
        sizeBytes: built.artifactSizeBytes,
      });
      await tx
        .update(serverRules)
        .set({ jsonUrl: built.jsonUrl, version: String(version), updatedAt: new Date() })
        .where(eq(serverRules.id, ruleSetId));
      await tx.insert(changeEnvelopes).values({
        id: createdId,
        serverId: server.id,
        userId,
        ruleVersionId: createdRuleVersionId,
        ruleVersion: version,
        title: input.title,
        rationale: input.rationale,
        source: "form",
        document,
        contentDigest: built.contentDigest,
        artifactDigest: built.artifactDigest,
        runtimeDigest: built.runtimeDigest,
        runtimeMinecraftVersion: built.runtimeMinecraftVersion,
      });
      await tx.insert(controlPlaneEvents).values({
        serverId: server.id,
        type: "change_submitted",
        data: {
          change_id: createdId,
          title: input.title,
          rule_version: version,
          content_digest: built.contentDigest,
          artifact_digest: built.artifactDigest,
        },
      });
    });

    return this.get(userId, createdId);
  }

  static async approve(userId: string, id: string, ifMatch: string | undefined) {
    const reviewedDigest = reviewedDigestFromIfMatch(ifMatch);
    if (!reviewedDigest) {
      throw new ChangeOperationError(
        428,
        "Approval requires If-Match for the reviewed artifact digest.",
      );
    }
    const preliminary = await envelopeById(userId, id);
    if (!preliminary) throw new ChangeOperationError(404, "Change not found");
    if (!digestsEqual(reviewedDigest, preliminary.envelope.artifactDigest)) {
      throw new ChangeOperationError(
        412,
        "The reviewed artifact changed; reload before approving.",
      );
    }
    if (preliminary.envelope.status === "rejected") {
      throw new ChangeOperationError(409, "A rejected change cannot be approved.");
    }
    if (preliminary.envelope.status === "approved") {
      await admitQueuedDeployments();
      return this.get(userId, id);
    }

    const artifact = await RulesService.resolveDeploymentArtifact({
      serverId: preliminary.envelope.serverId,
      userId,
      ruleSetVersion: String(preliminary.envelope.ruleVersion),
    });
    if (!digestsEqual(artifact.artifactDigest, reviewedDigest)) {
      throw new ChangeOperationError(
        409,
        "The immutable artifact does not match the review envelope.",
      );
    }
    await RulesService.verifyDeploymentArtifact(artifact);

    const claim = deployRulesApprovalClaim(
      preliminary.envelope.serverId,
      preliminary.envelope.ruleVersion,
      reviewedDigest,
    );
    const approval = await operationApprovalService.mint({
      issuedTo: userId,
      issuedBy: userId,
      claim,
    });
    const refusal = await operationApprovalService.redeem({
      token: approval.token,
      issuedTo: userId,
      claim,
    });
    if (refusal) throw new ChangeOperationError(403, `Approval could not be redeemed: ${refusal}`);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`review:${id}`}))`);
      const [locked] = await tx
        .select()
        .from(changeEnvelopes)
        .where(and(eq(changeEnvelopes.id, id), eq(changeEnvelopes.userId, userId)))
        .for("update");
      if (!locked) throw new ChangeOperationError(404, "Change not found");
      if (locked.status === "rejected") {
        throw new ChangeOperationError(409, "A rejected change cannot be approved.");
      }
      if (locked.status === "approved") return;
      if (!digestsEqual(locked.artifactDigest, reviewedDigest)) {
        throw new ChangeOperationError(
          412,
          "The reviewed artifact changed; reload before approving.",
        );
      }

      const deploymentId = deterministicDeploymentId(id);
      await tx.insert(controlPlaneEvents).values({
        serverId: locked.serverId,
        type: "change_reviewed",
        data: {
          change_id: id,
          verdict: "approved",
          artifact_digest: reviewedDigest,
          deployment_id: deploymentId,
        },
      });
      const [existingDeployment] = await tx
        .select({
          serverId: deployments.serverId,
          userId: deployments.userId,
          initiatedBy: deployments.initiatedBy,
          toVersion: deployments.toVersion,
          approvedContentDigest: deployments.approvedContentDigest,
        })
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      if (existingDeployment) {
        if (
          existingDeployment.serverId !== locked.serverId ||
          existingDeployment.userId !== userId ||
          existingDeployment.initiatedBy !== userId ||
          existingDeployment.toVersion !== String(locked.ruleVersion) ||
          !digestsEqual(existingDeployment.approvedContentDigest, reviewedDigest)
        ) {
          throw new ChangeOperationError(
            409,
            "The deterministic deployment identity is bound to another operation.",
          );
        }
      } else {
        const [head] = await tx
          .select({ currentVersion: serverRuleHeads.currentVersion })
          .from(serverRuleHeads)
          .where(eq(serverRuleHeads.serverId, locked.serverId))
          .limit(1);
        await createDeploymentRecordInTransaction(
          tx,
          queuedDeploymentRecord(
            {
              deploymentId,
              serverId: locked.serverId,
              ruleSetVersion: String(locked.ruleVersion),
              approvedContentDigest: reviewedDigest,
              initiatedBy: userId,
              userId,
            },
            head?.currentVersion ?? null,
          ),
        );
      }
      const reviewedAt = new Date();
      await tx
        .update(changeEnvelopes)
        .set({
          status: "approved",
          reviewedArtifactDigest: reviewedDigest,
          reviewedBy: userId,
          reviewedAt,
          deploymentId,
          updatedAt: reviewedAt,
        })
        .where(eq(changeEnvelopes.id, id));
    });

    await admitQueuedDeployments();

    return this.get(userId, id);
  }

  static async reject(userId: string, id: string, reason: string) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`review:${id}`}))`);
      const [locked] = await tx
        .select()
        .from(changeEnvelopes)
        .where(and(eq(changeEnvelopes.id, id), eq(changeEnvelopes.userId, userId)))
        .for("update");
      if (!locked) throw new ChangeOperationError(404, "Change not found");
      if (locked.status === "approved") {
        throw new ChangeOperationError(409, "An approved change cannot be rejected.");
      }
      if (locked.status === "rejected") return;
      const reviewedAt = new Date();
      await tx
        .update(changeEnvelopes)
        .set({
          status: "rejected",
          reviewedBy: userId,
          reviewedAt,
          rejectionReason: reason,
          updatedAt: reviewedAt,
        })
        .where(eq(changeEnvelopes.id, id));
      await tx.insert(controlPlaneEvents).values({
        serverId: locked.serverId,
        type: "change_reviewed",
        data: {
          change_id: id,
          verdict: "rejected",
          artifact_digest: locked.artifactDigest,
          deployment_id: null,
        },
      });
    });
    return this.get(userId, id);
  }
}
