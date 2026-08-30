import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { app } from "../src/app";

describe("backup route authentication", () => {
  let previousMockUserId: string | undefined;

  beforeAll(() => {
    previousMockUserId = process.env.MOCK_USER_ID;
    process.env.MOCK_USER_ID = "must-not-authorize-backup-routes";
  });

  afterAll(() => {
    if (previousMockUserId === undefined) {
      delete process.env.MOCK_USER_ID;
    } else {
      process.env.MOCK_USER_ID = previousMockUserId;
    }
  });

  test("rejects a create request without a session cookie", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/servers/server-id/backups/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unauthorized backup" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");
  });

  test("registers an authenticated schedule endpoint before backup lookup", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/servers/server-id/backups/schedule"),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");

    const getPaths = app.routes
      .filter((route) => route.method === "GET")
      .map((route) => route.path);
    expect(getPaths.indexOf("/api/servers/:serverId/backups/schedule")).toBeGreaterThanOrEqual(0);
    expect(getPaths.indexOf("/api/servers/:serverId/backups/schedule")).toBeLessThan(
      getPaths.indexOf("/api/servers/:serverId/backups/:backupId"),
    );
  });

  test("rejects a download request before generating a signed URL", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/servers/server-id/backups/backup-id/download"),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");
  });
});
