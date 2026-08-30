import { Elysia, t } from "elysia";
import { internalAuthRefusal, verifyInternalServiceRequest } from "../auth/internal-service";
import { ackTransfer, listPendingTransfers } from "./transfers";

export const velocityModule = new Elysia({ prefix: "/internal/velocity" })
  .onBeforeHandle(({ headers, set }) => {
    const result = verifyInternalServiceRequest(headers);
    if (result === "authorized") return;
    const refusal = internalAuthRefusal(result);
    set.status = refusal.status;
    return refusal.body;
  })
  .get("/transfers", () => listPendingTransfers())
  .post("/transfers/:id/ack", ({ params, body }) => ackTransfer(params.id, body), {
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
