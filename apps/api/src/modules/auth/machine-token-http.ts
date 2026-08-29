import { Elysia, t } from "elysia";
import { machineTokenService } from "./machine-tokens";
import { AuthService } from "./service";

export const machineTokenModule = new Elysia({
  name: "machine-token-management",
  prefix: "/api/machine-tokens",
})
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireHumanSessionUserIdFromHeaders(headers),
  }))
  .get("/", async ({ userId }) => {
    const items = await machineTokenService.list(userId);
    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        created_at: item.createdAt.toISOString(),
        expires_at: item.expiresAt.toISOString(),
        revoked_at: item.revokedAt?.toISOString() ?? null,
        active: item.active,
      })),
    };
  })
  .post(
    "/",
    async ({ userId, body, set }) => {
      const minted = await machineTokenService.mint({
        userId,
        name: body.name,
        expiresInDays: body.expires_in_days,
      });
      set.status = 201;
      return {
        id: minted.id,
        name: minted.name,
        token: minted.token,
        created_at: minted.createdAt.toISOString(),
        expires_at: minted.expiresAt.toISOString(),
      };
    },
    {
      body: t.Object(
        {
          name: t.String({ minLength: 1, maxLength: 80 }),
          expires_in_days: t.Optional(t.Integer({ minimum: 1, maximum: 365 })),
        },
        { additionalProperties: false },
      ),
    },
  )
  .delete(
    "/:id",
    async ({ userId, params, set }) => {
      const revoked = await machineTokenService.revoke(userId, params.id);
      if (!revoked) {
        set.status = 404;
        return { revoked: false, error: "Machine token not found" };
      }
      return { revoked: true };
    },
    {
      params: t.Object({ id: t.String({ pattern: "^mtk_[0-9a-f]{32}$" }) }),
    },
  );
