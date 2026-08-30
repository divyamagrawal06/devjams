import { Elysia, t } from "elysia";
import { internalAuthRefusal, verifyInternalServiceRequest } from "../auth/internal-service";
import { type RouteRosterService, routeRosterService } from "./roster";
import { type TransferService, transferService } from "./transfers";

export function createVelocityModule(
  service: TransferService = transferService,
  rosters: RouteRosterService = routeRosterService,
) {
  return new Elysia({ prefix: "/internal/velocity" })
    .onBeforeHandle(({ headers, set }) => {
      const result = verifyInternalServiceRequest(headers);
      if (result === "authorized") return;
      const refusal = internalAuthRefusal(result);
      set.status = refusal.status;
      return refusal.body;
    })
    .get("/transfers", async () => service.listPending())
    .post("/roster", async ({ body }) => rosters.report(body.routes), {
      body: t.Object(
        {
          routes: t.Array(
            t.Object(
              {
                route: t.String({ minLength: 1, maxLength: 253 }),
                targetHost: t.String({ minLength: 1, maxLength: 253 }),
                targetPort: t.Integer({ minimum: 1, maximum: 65535 }),
                players: t.Array(t.String({ minLength: 1, maxLength: 253 }), {
                  maxItems: 10_000,
                }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 2_000 },
          ),
        },
        { additionalProperties: false },
      ),
    })
    .post("/transfers/:id/ack", async ({ params, body }) => service.acknowledge(params.id, body), {
      body: t.Object({
        movedPlayers: t.Array(t.String()),
        failures: t.Array(
          t.Object({
            player: t.String(),
            reason: t.String(),
          }),
        ),
      }),
    });
}

export const velocityModule = createVelocityModule();
