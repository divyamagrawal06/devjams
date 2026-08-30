import { describe, expect, test } from "bun:test";

import { ApiError, farlandsApiPath, parseApiError } from "./api";

describe("web API errors", () => {
  test("keeps the status and a structured upstream message", async () => {
    const error = await parseApiError(
      new Response(JSON.stringify({ error: "conflict", message: "Stop the realm first." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.message).toBe("Stop the realm first.");
    expect(error.body).toEqual({ error: "conflict", message: "Stop the realm first." });
  });

  test("falls back to a plain-text response", async () => {
    const error = await parseApiError(new Response("Authentication required", { status: 401 }));
    expect(error.message).toBe("Authentication required");
  });

  test("builds the authenticated browser connector path", () => {
    expect(farlandsApiPath("/api/servers/realm-1/backups/")).toBe(
      "/api/farlands/api/servers/realm-1/backups/",
    );
  });
});
