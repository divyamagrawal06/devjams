import { digestsEqual } from "@farlands/contracts";
import { Elysia, t } from "elysia";
import { machineTokenService } from "../auth/machine-tokens";
import { AuthService } from "../auth/service";
import { RulesService } from "../rules/service";
import { ServerService } from "../servers/service";
import { deployRulesApprovalClaim, operationApprovalService } from "./approvals";

export type DeployApprovalMintRequest = {
  server_id: string;
  rule_set_version: number;
  content_digest: string;
  issued_to: string;
};

type MintAuthority = {
  ownsServer(userId: string, serverId: string): Promise<boolean>;
  canIssueTo(userId: string, principalId: string): Promise<boolean>;
};

const liveMintAuthority: MintAuthority = {
  ownsServer: ServerService.hasOwnership,
  canIssueTo: (userId, principalId) => machineTokenService.canReceiveApproval(userId, principalId),
};

export async function authorizeDeployApprovalMint(
  userId: string,
  input: DeployApprovalMintRequest,
  authority: MintAuthority = liveMintAuthority,
): Promise<"allowed" | "server_not_found" | "invalid_principal"> {
  if (!(await authority.ownsServer(userId, input.server_id))) return "server_not_found";
  if (!(await authority.canIssueTo(userId, input.issued_to))) return "invalid_principal";
  return "allowed";
}

export const operationApprovalModule = new Elysia({ name: "operation-approval-mint" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireHumanSessionUserIdFromHeaders(headers),
  }))
  .post(
    "/v1/approvals",
    async ({ userId, body, set }) => {
      const authorization = await authorizeDeployApprovalMint(userId, body);
      if (authorization === "server_not_found") {
        set.status = 404;
        return { error: "Server not found" };
      }
      if (authorization === "invalid_principal") {
        set.status = 400;
        return { error: "Approval recipient is not an active credential owned by this account" };
      }

      let artifact;
      try {
        artifact = await RulesService.resolveDeploymentArtifact({
          serverId: body.server_id,
          userId,
          ruleSetVersion: String(body.rule_set_version),
        });
        if (!digestsEqual(artifact.artifactDigest, body.content_digest)) {
          set.status = 409;
          return { error: "Reviewed digest does not match the immutable deployment artifact" };
        }
        await RulesService.verifyDeploymentArtifact(artifact);
      } catch (error) {
        set.status = 409;
        return {
          error: error instanceof Error ? error.message : "Reviewed artifact is unavailable",
        };
      }

      const claim = deployRulesApprovalClaim(
        body.server_id,
        body.rule_set_version,
        body.content_digest,
      );
      const minted = await operationApprovalService.mint({
        issuedTo: body.issued_to,
        issuedBy: userId,
        claim,
      });
      set.status = 201;
      return {
        token: minted.token,
        expires_at: minted.expiresAt.toISOString(),
        content_digest: body.content_digest,
      };
    },
    {
      body: t.Object(
        {
          server_id: t.String({ minLength: 1, maxLength: 128 }),
          rule_set_version: t.Integer({ minimum: 1 }),
          content_digest: t.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
          issued_to: t.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
    },
  );
