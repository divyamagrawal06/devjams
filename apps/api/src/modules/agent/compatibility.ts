import {
  AuthoringFailedError,
  authorRules,
  createAnthropicRuleModel,
  RuleModelError,
} from "@farlands/authoring";
import {
  clusterApprovalRequired,
  DRAFT_RATE_LIMIT,
  notFound,
  rateLimited,
  UNMEASURED_WINDOW,
} from "@farlands/contracts";
import {
  agentDraftAttempts,
  changeEnvelopes,
  ruleArtifacts,
  ruleSetVersions,
  serverRuleAssignments,
  serverRuleHeads,
  serverRules,
} from "@repo/db";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../db";
import { type AgentIdentity, AuthService } from "../auth/service";
import { describeDocumentChange } from "../changes/diff";
import { ChangeOperationError, ChangeService } from "../changes/service";
import { QuotaService } from "../quota/quota.service";
import { ServerService } from "../servers/service";
import { operationApprovalService, powerActionApprovalClaim } from "./approvals";

type LiveServerRow = Awaited<ReturnType<typeof ServerService.getAllByUser>>[number];

export function projectServerSummary(row: LiveServerRow, currentVersion: string | null) {
  const parsedVersion =
    currentVersion && /^\d+$/.test(currentVersion) ? Number(currentVersion) : null;
  return {
    server_id: row.id,
    name: row.name,
    hostname: row.hostname,
    state: row.currentState,
    // A fresh Velocity roster and TPS connector do not exist on this read path.
    // Null is intentionally different from inventing an empty server.
    player_count: null,
    max_players: null,
    tps: null,
    current_version: parsedVersion,
    regions: [],
    workload: {
      game: row.game,
      runtime: row.type,
      version: row.version,
    },
    observed_at: row.updatedAt.toISOString(),
  };
}

async function listRuleVersions(userId: string, serverId: string) {
  const rows = await db
    .select({
      ruleSetId: serverRules.id,
      ruleSetName: serverRules.name,
      ruleSetDescription: serverRules.description,
      id: ruleSetVersions.id,
      version: ruleSetVersions.version,
      jsonUrl: ruleSetVersions.jsonUrl,
      contentDigest: ruleSetVersions.contentDigest,
      source: ruleSetVersions.source,
      createdBy: ruleSetVersions.createdBy,
      createdAt: ruleSetVersions.createdAt,
      artifactDigest: ruleArtifacts.artifactDigest,
      runtimeDigest: ruleArtifacts.runtimeDigest,
      runtimeMinecraftVersion: ruleArtifacts.runtimeMinecraftVersion,
      document: changeEnvelopes.document,
    })
    .from(ruleSetVersions)
    .innerJoin(ruleArtifacts, eq(ruleArtifacts.ruleVersionId, ruleSetVersions.id))
    .innerJoin(serverRules, eq(serverRules.id, ruleSetVersions.ruleSetId))
    .innerJoin(serverRuleAssignments, eq(serverRuleAssignments.ruleId, serverRules.id))
    .leftJoin(changeEnvelopes, eq(changeEnvelopes.ruleVersionId, ruleSetVersions.id))
    .where(
      and(
        eq(serverRules.createdBy, userId),
        eq(serverRuleAssignments.serverId, serverId),
        eq(serverRuleAssignments.isActive, true),
      ),
    )
    .orderBy(asc(ruleSetVersions.version));

  return rows.map((row) => ({
    id: row.id,
    rule_set_id: row.ruleSetId,
    rule_set_name: row.ruleSetName,
    rule_set_description: row.ruleSetDescription,
    version: row.version,
    json_url: row.jsonUrl,
    content_digest: row.contentDigest,
    // Approval and deployment bind this value, because these are the bytes the
    // candidate mounts. The document digest remains separately available above.
    artifact_digest: row.artifactDigest,
    runtime_digest: row.runtimeDigest,
    runtime_minecraft_version: row.runtimeMinecraftVersion,
    built_jar_url: null,
    source: row.source,
    source_prompt: null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    document: row.document,
  }));
}

function versionNumber(value: string | null): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

export function selectPreviewTarget(input: {
  requestedVersion?: number;
  currentVersion: string | null;
  previousVersion: string | null;
  availableVersions: readonly number[];
}) {
  const current = versionNumber(input.currentVersion);
  const previous = versionNumber(input.previousVersion);
  const target = input.requestedVersion ?? previous;
  if (target === null || !input.availableVersions.includes(target)) return null;
  return {
    fromVersion: current,
    toVersion: target,
    rollbackTarget: input.requestedVersion === undefined ? previous : current,
  };
}

function ruleDiff(
  serverId: string,
  fromVersion: number | null,
  toVersion: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  return {
    server_id: serverId,
    from_version: fromVersion,
    to_version: toVersion,
    entries:
      after === null
        ? []
        : describeDocumentChange(before, after).map((entry) => ({
            kind: entry.kind,
            rule_id: entry.path,
            summary: entry.summary,
            before: entry.before,
            after: entry.after,
          })),
    basis: after === null ? "digests_only" : "documents",
  };
}

async function ruleHead(serverId: string) {
  const [head] = await db
    .select()
    .from(serverRuleHeads)
    .where(eq(serverRuleHeads.serverId, serverId))
    .limit(1);
  return (
    head ?? {
      serverId,
      currentVersion: null,
      currentDigest: null,
      previousVersion: null,
      previousDigest: null,
      currentDeploymentId: null,
      updatedAt: new Date(0),
    }
  );
}

async function authoringBudget(identity: AgentIdentity, serverId: string) {
  const since = new Date(Date.now() - DRAFT_RATE_LIMIT.window_seconds * 1000);
  return db.transaction(async (tx) => {
    // Serialise one principal/server budget so concurrent requests cannot all
    // pass the count and then spend beyond the published limit.
    await tx.execute(
      // Both values are authenticated/owned identifiers and are still bound as
      // parameters by Drizzle rather than interpolated into SQL text.
      sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-draft:${identity.principalId}:${serverId}`}))`,
    );
    const [usage] = await tx
      .select({ value: count() })
      .from(agentDraftAttempts)
      .where(
        and(
          eq(agentDraftAttempts.serverId, serverId),
          eq(agentDraftAttempts.principalId, identity.principalId),
          gte(agentDraftAttempts.createdAt, since),
        ),
      );
    const spent = Number(usage?.value ?? 0);
    if (spent >= DRAFT_RATE_LIMIT.calls) return false;
    await tx.insert(agentDraftAttempts).values({
      serverId,
      principalId: identity.principalId,
    });
    return true;
  });
}

function operationFailure(error: unknown, set: { status?: number | string }) {
  if (error instanceof ChangeOperationError) {
    set.status = error.status;
    return { error: "draft_failed", message: error.message };
  }
  if (error instanceof AuthoringFailedError) {
    set.status = 422;
    return error.failure;
  }
  if (error instanceof RuleModelError) {
    set.status = 502;
    return { error: "authoring_provider_failed", message: error.message };
  }
  console.error("Agent compatibility operation failed", {
    message: error instanceof Error ? error.message : "Unknown failure",
  });
  set.status = 500;
  return { error: "operation_failed", message: "The requested operation could not complete." };
}

const authorBody = t.Object(
  { prompt: t.String({ minLength: 1, maxLength: 4000 }) },
  { additionalProperties: false },
);
const previewBody = t.Optional(
  t.Object(
    { rule_set_version: t.Optional(t.Integer({ minimum: 1 })) },
    { additionalProperties: false },
  ),
);

export const agentCompatibilityModule = new Elysia({ name: "agent-v1-compatibility" })
  .derive(async ({ headers }) => ({
    identity: await AuthService.requireAgentIdentityFromHeaders(headers),
  }))
  .get("/v1/servers", async ({ identity }) => {
    const servers = await ServerService.getAllByUser(identity.userId);
    if (servers.length === 0) return { items: [], next_cursor: null };
    const heads = await db
      .select({
        serverId: serverRuleHeads.serverId,
        currentVersion: serverRuleHeads.currentVersion,
      })
      .from(serverRuleHeads)
      .where(
        inArray(
          serverRuleHeads.serverId,
          servers.map((server) => server.id),
        ),
      );
    const versions = new Map(heads.map((head) => [head.serverId, head.currentVersion]));
    return {
      items: servers.map((server) => projectServerSummary(server, versions.get(server.id) ?? null)),
      next_cursor: null,
    };
  })
  .get("/v1/servers/:id", async ({ identity, params, set }) => {
    if (!(await ServerService.hasOwnership(identity.userId, params.id))) {
      set.status = 404;
      return notFound({ tool: "get_server", resource: `server ${params.id}` });
    }
    const [server, head] = await Promise.all([
      ServerService.getById(identity.userId, params.id),
      ruleHead(params.id),
    ]);
    return projectServerSummary(server, head.currentVersion);
  })
  .get("/v1/servers/:id/rule-sets", async ({ identity, params, set }) => {
    if (!(await ServerService.hasOwnership(identity.userId, params.id))) {
      set.status = 404;
      return notFound({ tool: "list_rule_sets", resource: `server ${params.id}` });
    }
    return { items: await listRuleVersions(identity.userId, params.id), next_cursor: null };
  })
  .post(
    "/v1/servers/:id/rule-sets/author",
    async ({ identity, params, body, set }) => {
      if (!(await ServerService.hasOwnership(identity.userId, params.id))) {
        set.status = 404;
        return notFound({ tool: "author_rules", resource: `server ${params.id}` });
      }
      const server = await ServerService.getById(identity.userId, params.id);
      if (server.game !== "minecraft") {
        set.status = 409;
        return {
          error: "unsupported_workload",
          message: "Live rule authoring is available only for Minecraft workloads.",
        };
      }
      if (!process.env.ANTHROPIC_API_KEY?.trim()) {
        set.status = 503;
        return {
          error: "authoring_unavailable",
          message: "Rule authoring is unavailable until the model connector is configured.",
        };
      }
      if (!(await authoringBudget(identity, params.id))) {
        set.status = 429;
        return rateLimited({
          tool: "author_rules",
          server_id: params.id,
          limit: DRAFT_RATE_LIMIT.calls,
          window_seconds: DRAFT_RATE_LIMIT.window_seconds,
          retry_after_seconds: DRAFT_RATE_LIMIT.window_seconds,
        });
      }

      try {
        const authored = await authorRules(params.id, body.prompt, {
          model: createAnthropicRuleModel(),
          context: { server_id: params.id, regions: [] },
          source: "agent",
          createdBy: identity.principalId,
          serverName: server.name,
        });
        const change = await ChangeService.create(
          identity.userId,
          {
            serverId: params.id,
            title: "Agent-authored rule draft",
            rationale:
              "Drafted through the authenticated agent authoring route. A human must review the exact artifact before deployment.",
            document: authored.document,
          },
          { source: "agent" },
        );
        const rows = await listRuleVersions(identity.userId, params.id);
        const version = rows.find((row) => row.id === change.ruleVersionId);
        if (!version) throw new Error("Created rule version could not be read back");
        set.status = 201;
        return {
          version,
          diff: ruleDiff(
            params.id,
            change.ruleVersion > 1 ? change.ruleVersion - 1 : null,
            change.ruleVersion,
            null,
            change.document,
          ),
          attempts: authored.attempts,
          change_id: change.id,
          review_status: change.status,
        };
      } catch (error) {
        return operationFailure(error, set);
      }
    },
    { body: authorBody },
  )
  .post(
    "/v1/servers/:id/preview",
    async ({ identity, params, body, set }) => {
      if (!(await ServerService.hasOwnership(identity.userId, params.id))) {
        set.status = 404;
        return notFound({ tool: "preview_deploy", resource: `server ${params.id}` });
      }
      const [versions, head, server, quota] = await Promise.all([
        listRuleVersions(identity.userId, params.id),
        ruleHead(params.id),
        ServerService.getById(identity.userId, params.id),
        QuotaService.getResourceUsage(identity.userId),
      ]);
      const selection = selectPreviewTarget({
        requestedVersion: body?.rule_set_version,
        currentVersion: head.currentVersion,
        previousVersion: head.previousVersion,
        availableVersions: versions.map((version) => version.version),
      });
      if (!selection) {
        set.status = 404;
        return notFound({
          tool: "preview_deploy",
          resource:
            body?.rule_set_version === undefined
              ? `rollback target on server ${params.id}`
              : `rule set version ${body.rule_set_version} on server ${params.id}`,
        });
      }
      const target = versions.find((version) => version.version === selection.toVersion)!;
      const current = versions.find((version) => version.version === selection.fromVersion);
      const cpuMillicores = Math.max(0, Math.round(Number(server.cpuCores ?? 0) * 1000));
      const memoryMib = Math.max(0, server.ramMb ?? 0);
      const storageMib = Math.max(0, (server.storageGb ?? 0) * 1024);
      const headroomAvailable = Boolean(
        quota &&
          !quota.overQuota &&
          !quota.deploymentHeadroomReserved &&
          Number(quota.cpuUsed) + cpuMillicores / 1000 <= Number(quota.cpuLimit) &&
          quota.ramUsedMb + memoryMib <= quota.ramLimitMb &&
          quota.storageUsedGb + storageMib / 1024 <= quota.storageLimitGb,
      );
      return {
        server_id: params.id,
        from_version: selection.fromVersion,
        to_version: selection.toVersion,
        content_digest: target.artifact_digest,
        document_digest: target.content_digest,
        diff: ruleDiff(
          params.id,
          selection.fromVersion,
          selection.toVersion,
          current?.document ?? null,
          target.document,
        ),
        estimated_window: UNMEASURED_WINDOW,
        quota_impact: {
          candidate_cpu_millicores: cpuMillicores,
          candidate_memory_mib: memoryMib,
          candidate_storage_mib: storageMib,
          headroom_available: headroomAvailable,
        },
        rollback_target: selection.rollbackTarget,
      };
    },
    { body: previewBody },
  )
  .post(
    "/v1/servers/:id/power",
    async ({ identity, params, body, set }) => {
      if (!(await ServerService.hasOwnership(identity.userId, params.id))) {
        set.status = 404;
        return notFound({ tool: "power_action", resource: `server ${params.id}` });
      }
      const claim = powerActionApprovalClaim(params.id, body.action);
      const refusal = await operationApprovalService.redeem({
        token: body.approval_token,
        issuedTo: identity.principalId,
        claim,
      });
      if (refusal) {
        set.status = 403;
        return clusterApprovalRequired({
          reason: refusal,
          tool: "power_action",
          server_id: params.id,
          operation: body.action,
        });
      }
      return ServerService.performAction(params.id, identity.userId, {
        action: body.action,
        requestKey: `agent:${identity.principalId}:${crypto.randomUUID()}`,
      });
    },
    {
      body: t.Object(
        {
          action: t.Union([t.Literal("start"), t.Literal("stop"), t.Literal("restart")]),
          approval_token: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
        },
        { additionalProperties: false },
      ),
    },
  )
  .post(
    "/v1/servers",
    ({ set }) => {
      set.status = 422;
      return {
        error: "workload_spec_required",
        message:
          "Name-only provisioning is unavailable. Use structured onboarding to choose an exact workload kind, version, runtime, resources, and storage allocation.",
      };
    },
    {
      body: t.Object(
        {
          name: t.String({ minLength: 1, maxLength: 64 }),
          approval_token: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
        },
        { additionalProperties: false },
      ),
    },
  );
