import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  internalAuthRefusal,
  verifyInternalServiceRequest,
} from "../src/modules/auth/internal-service";
import { createVelocityModule } from "../src/modules/velocity/http";
import { MemoryRouteRosterStore, RouteRosterService } from "../src/modules/velocity/roster";
import { MemoryTransferStore, TransferService } from "../src/modules/velocity/transfers";

const rosterStore = new MemoryRouteRosterStore();
const velocityApp = new Elysia().use(
  createVelocityModule(
    new TransferService(new MemoryTransferStore(), () => new Date("2026-08-30T12:00:00.000Z")),
    new RouteRosterService(rosterStore, () => new Date("2026-08-30T12:00:00.000Z")),
  ),
);

const originalInternalKey = process.env.INTERNAL_API_KEY;

afterEach(() => {
  if (originalInternalKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = originalInternalKey;
});

describe("internal service authentication", () => {
  test("fails closed when the shared key is missing, wrong, or absent", () => {
    expect(verifyInternalServiceRequest({}, "")).toBe("unconfigured");
    expect(verifyInternalServiceRequest({}, "correct horse battery staple")).toBe("unauthorized");
    expect(
      verifyInternalServiceRequest({ "x-internal-key": "wrong" }, "correct horse battery staple"),
    ).toBe("unauthorized");
    expect(internalAuthRefusal("unconfigured").status).toBe(503);
    expect(internalAuthRefusal("unauthorized").status).toBe(401);
  });

  test("accepts only the exact configured key", () => {
    expect(
      verifyInternalServiceRequest(
        { "x-internal-key": "correct horse battery staple" },
        "correct horse battery staple",
      ),
    ).toBe("authorized");
    expect(
      verifyInternalServiceRequest(
        { "x-internal-key": "correct horse battery staple " },
        "correct horse battery staple",
      ),
    ).toBe("unauthorized");
  });

  test("protects both reads and mutation acknowledgements on the Velocity route", async () => {
    delete process.env.INTERNAL_API_KEY;
    const unconfigured = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/transfers"),
    );
    expect(unconfigured.status).toBe(503);

    process.env.INTERNAL_API_KEY = "cluster-only-secret";
    const missing = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/transfers"),
    );
    expect(missing.status).toBe(401);

    const wrongAck = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/transfers/tx_missing/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-key": "wrong" },
        body: JSON.stringify({ movedPlayers: [], failures: [] }),
      }),
    );
    expect(wrongAck.status).toBe(401);

    const wrongRoster = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/roster", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-key": "wrong" },
        body: JSON.stringify({ routes: [] }),
      }),
    );
    expect(wrongRoster.status).toBe(401);

    const authorized = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/transfers", {
        headers: { "x-internal-key": "cluster-only-secret" },
      }),
    );
    expect(authorized.status).toBe(200);

    const authorizedRoster = await velocityApp.handle(
      new Request("http://localhost/internal/velocity/roster", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-key": "cluster-only-secret",
        },
        body: JSON.stringify({
          routes: [
            {
              route: "realm-a",
              targetHost: "svc-a.example",
              targetPort: 25565,
              players: ["Alice"],
            },
          ],
        }),
      }),
    );
    expect(authorizedRoster.status).toBe(200);
    expect(await rosterStore.find("realm-a")).toMatchObject({ players: ["Alice"] });
  });
});
