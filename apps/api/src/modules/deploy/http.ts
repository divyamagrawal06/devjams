import { approvalRequired, notFound } from "@farlands/contracts";
import { Elysia, t } from "elysia";
import {
  deployRulesApprovalClaim,
  operationApprovalService,
  rollbackRulesApprovalClaim,
} from "../agent/approvals";
import { AuthService } from "../auth/service";
import { ServerService } from "../servers/service";
import {
  abortDeployment,
  enqueueDeploy,
  getDeployment,
  reconcileInFlight,
  rollbackServer,
} from "./controller";

export async function ownsDeploymentTarget(
  userId: string,
  serverId: string,
  ownsServer: (userId: string, serverId: string) => Promise<boolean> = ServerService.hasOwnership,
): Promise<boolean> {
  return ownsServer(userId, serverId);
}

const ruleOperationBody = t.Object(
  {
    rule_set_version: t.Integer({ minimum: 1 }),
    content_digest: t.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    approval_token: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

export const deployModule = new Elysia({ name: "authenticated-deployments" })
  .onStart(async () => {
    await reconcileInFlight();
  })
  .derive(async ({ headers }) => ({
    identity: await AuthService.requireAgentIdentityFromHeaders(headers),
  }))
  .post(
    "/v1/servers/:id/deploy",
    async ({ identity, params, body, set }) => {
      if (!(await ownsDeploymentTarget(identity.userId, params.id))) {
        set.status = 404;
        return notFound({ tool: "deploy_rules", resource: `server ${params.id}` });
      }

      const claim = deployRulesApprovalClaim(params.id, body.rule_set_version, body.content_digest);
      const refusalReason = await operationApprovalService.redeem({
        token: body.approval_token,
        issuedTo: identity.principalId,
        claim,
      });
      if (refusalReason) {
        set.status = 403;
        return approvalRequired({
          reason: refusalReason,
          tool: "deploy_rules",
          server_id: params.id,
          rule_set_version: body.rule_set_version,
          content_digest: body.content_digest,
        });
      }

      try {
        return await enqueueDeploy({
          serverId: params.id,
          ruleSetVersion: String(body.rule_set_version),
          approvedContentDigest: body.content_digest,
          initiatedBy: identity.principalId,
          userId: identity.userId,
        });
      } catch (error) {
        set.status = 400;
        return { error: error instanceof Error ? error.message : "deploy refused" };
      }
    },
    { body: ruleOperationBody },
  )
  .get("/v1/deployments/:id", async ({ identity, params, set }) => {
    const row = getDeployment(params.id);
    if (!row || !(await ownsDeploymentTarget(identity.userId, row.serverId))) {
      set.status = 404;
      return notFound({ tool: "get_deployment", resource: `deployment ${params.id}` });
    }
    return row;
  })
  .post("/v1/deployments/:id/abort", async ({ identity, params, set }) => {
    const row = getDeployment(params.id);
    if (!row || !(await ownsDeploymentTarget(identity.userId, row.serverId))) {
      set.status = 404;
      return notFound({ tool: "abort", resource: `deployment ${params.id}` });
    }
    try {
      return await abortDeployment(params.id);
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "abort refused" };
    }
  })
  .post(
    "/v1/servers/:id/rollback",
    async ({ identity, params, body, set }) => {
      if (!(await ownsDeploymentTarget(identity.userId, params.id))) {
        set.status = 404;
        return notFound({ tool: "rollback", resource: `server ${params.id}` });
      }

      const claim = rollbackRulesApprovalClaim(
        params.id,
        body.rule_set_version,
        body.content_digest,
      );
      const refusalReason = await operationApprovalService.redeem({
        token: body.approval_token,
        issuedTo: identity.principalId,
        claim,
      });
      if (refusalReason) {
        set.status = 403;
        return approvalRequired({
          reason: refusalReason,
          tool: "rollback",
          server_id: params.id,
          rule_set_version: body.rule_set_version,
          content_digest: body.content_digest,
        });
      }

      try {
        return await rollbackServer({
          serverId: params.id,
          targetVersion: String(body.rule_set_version),
          approvedContentDigest: body.content_digest,
          initiatedBy: identity.principalId,
          userId: identity.userId,
        });
      } catch (error) {
        set.status = 400;
        return { error: error instanceof Error ? error.message : "rollback refused" };
      }
    },
    { body: ruleOperationBody },
  )
  .post("/v1/servers/:id/restore", async ({ identity, params, set }) => {
    if (!(await ownsDeploymentTarget(identity.userId, params.id))) {
      set.status = 404;
      return notFound({ tool: "restore", resource: `server ${params.id}` });
    }
    set.status = 501;
    return {
      error: "not_implemented",
      message: "Snapshot restore remains unavailable until a verified snapshot target is selected.",
    };
  });
