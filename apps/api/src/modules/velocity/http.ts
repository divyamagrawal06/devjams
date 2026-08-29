import { Elysia, t } from "elysia";
import { internalAuthRefusal, verifyInternalServiceRequest } from "../auth/internal-service";
import { type TransferService, transferService } from "./transfers";

export function createVelocityModule(service: TransferService = transferService) {
  return new Elysia({ prefix: "/internal/velocity" })
    .onBeforeHandle(({ headers, set }) => {
      const result = verifyInternalServiceRequest(headers);
      if (result === "authorized") return;
      const refusal = internalAuthRefusal(result);
      set.status = refusal.status;
      return refusal.body;
    })
    .get("/transfers", async () => service.listPending())
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
