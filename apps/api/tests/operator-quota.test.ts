import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { maintenanceBounds, operatorModule, windowsOverlap } from "../src/modules/operator/http";
import { allocationViolations } from "../src/modules/quota/quota.service";
import { serversModule } from "../src/modules/servers";
import { operatorReceiptDisposition } from "../src/modules/servers/service";

describe("aggregate quota and operator safety", () => {
  test("admits aggregate capacity, not one oversized-per-server interpretation", () => {
    const limits = { serversLimit: 3, cpuLimit: 6, ramLimitMb: 8192, storageLimitGb: 40 };
    expect(
      allocationViolations(limits, { servers: 3, cpu: 6, ramMb: 8192, storageGb: 40 }),
    ).toEqual([]);
    expect(
      allocationViolations(limits, { servers: 2, cpu: 7, ramMb: 8192, storageGb: 20 }),
    ).toEqual(["cpu"]);
    expect(
      allocationViolations(limits, { servers: 4, cpu: 7, ramMb: 9000, storageGb: 41 }),
    ).toEqual(["servers", "cpu", "ram", "storage"]);
  });

  test("bounds maintenance and rejects overlapping windows", () => {
    const now = new Date("2026-08-30T12:00:00Z");
    expect(maintenanceBounds(new Date("2026-08-30T12:04:59Z"), now)).toBe("too_soon");
    expect(maintenanceBounds(new Date("2026-08-30T12:05:00Z"), now)).toBe("valid");
    expect(maintenanceBounds(new Date("2026-12-01T00:00:00Z"), now)).toBe("too_far");
    expect(
      windowsOverlap(
        { startsAt: new Date("2026-08-30T13:00:00Z"), durationMinutes: 60 },
        { startsAt: new Date("2026-08-30T13:59:00Z"), durationMinutes: 15 },
      ),
    ).toBe(true);
    expect(
      windowsOverlap(
        { startsAt: new Date("2026-08-30T13:00:00Z"), durationMinutes: 60 },
        { startsAt: new Date("2026-08-30T14:00:00Z"), durationMinutes: 15 },
      ),
    ).toBe(false);
  });

  test("retries terminal receipts without changing their operation identity", () => {
    const base = { serverId: "server-a", action: "stop", status: "accepted" };
    expect(operatorReceiptDisposition(null, "server-a", "stop")).toBe("create");
    expect(operatorReceiptDisposition(base, "server-a", "stop")).toBe("reuse");
    expect(operatorReceiptDisposition({ ...base, status: "completed" }, "server-a", "stop")).toBe(
      "reuse",
    );
    expect(operatorReceiptDisposition({ ...base, status: "failed" }, "server-a", "stop")).toBe(
      "retry",
    );
    expect(operatorReceiptDisposition({ ...base, status: "refused" }, "server-a", "stop")).toBe(
      "retry",
    );
    expect(operatorReceiptDisposition(base, "server-b", "stop")).toBe("conflict");
    expect(operatorReceiptDisposition(base, "server-a", "restart")).toBe("conflict");
  });

  test("all operator and workload catalogue routes fail closed without a session", async () => {
    const app = new Elysia().use(operatorModule).use(serversModule);
    for (const request of [
      new Request("http://localhost/api/operator/"),
      new Request("http://localhost/api/operator/notifications", { method: "PUT" }),
      new Request("http://localhost/api/operator/maintenance", { method: "POST" }),
      new Request("http://localhost/api/operator/maintenance/mnt_unknown", { method: "DELETE" }),
      new Request("http://localhost/api/servers/templates"),
    ]) {
      expect((await app.handle(request)).status).toBe(401);
    }
  });
});
