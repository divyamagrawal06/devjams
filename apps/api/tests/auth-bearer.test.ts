import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

type SessionRecord = {
  userId: string;
  token: string;
  expiresAt: Date;
};

let sessionRecord: SessionRecord | null;
let machineRecord: { id: string; userId: string; expiresAt: Date; revokedAt: Date | null } | null;
let machineLookups = 0;
let sessionLookups = 0;

mock.module("../src/db", () => ({
  db: {
    query: {
      sessions: {
        findFirst: async () => {
          sessionLookups += 1;
          return sessionRecord;
        },
      },
      machineTokens: {
        findFirst: async () => {
          machineLookups += 1;
          if (!machineRecord || machineRecord.revokedAt || machineRecord.expiresAt <= new Date()) {
            return null;
          }
          return { id: machineRecord.id, userId: machineRecord.userId };
        },
      },
      users: {
        findFirst: async () => null,
      },
    },
  },
}));

const { AuthService } = await import("../src/modules/auth/service");
const { operationApprovalModule } = await import("../src/modules/agent/approval-http");
const { machineTokenModule } = await import("../src/modules/auth/machine-token-http");

const humanAuthorityApp = new Elysia().use(machineTokenModule).use(operationApprovalModule);

const originalMockUserId = process.env.MOCK_USER_ID;

beforeEach(() => {
  sessionRecord = {
    userId: "liveoperator",
    token: "operator-session",
    expiresAt: new Date(Date.now() + 60_000),
  };
  machineRecord = null;
  machineLookups = 0;
  sessionLookups = 0;
});

afterAll(() => {
  if (originalMockUserId === undefined) {
    delete process.env.MOCK_USER_ID;
  } else {
    process.env.MOCK_USER_ID = originalMockUserId;
  }
  mock.restore();
});

test("session cookie still authenticates", async () => {
  await expect(AuthService.requireUserId("session_token=operator-session")).resolves.toBe(
    "liveoperator",
  );
});

test("Authorization Bearer with a session token authenticates MCP", async () => {
  await expect(AuthService.requireUserId("", "Bearer operator-session")).resolves.toBe(
    "liveoperator",
  );
});

test("an active machine token authenticates only the agent surface", async () => {
  const token = `flk_${"a".repeat(43)}`;
  machineRecord = {
    id: `mtk_${"c".repeat(32)}`,
    userId: "machine-owner",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  };

  await expect(
    AuthService.requireAgentUserIdFromHeaders({ authorization: `Bearer ${token}` }),
  ).resolves.toBe("machine-owner");
  await expect(
    AuthService.requireAgentIdentityFromHeaders({ authorization: `Bearer ${token}` }),
  ).resolves.toEqual({
    userId: "machine-owner",
    principalId: `mtk_${"c".repeat(32)}`,
    kind: "machine",
  });
  expect(machineLookups).toBe(2);
  expect(sessionLookups).toBe(0);

  await expect(AuthService.requireUserId("", `Bearer ${token}`)).rejects.toMatchObject({
    code: 401,
  });
  expect(machineLookups).toBe(2);
});

test("expired, revoked, and malformed machine tokens fail closed", async () => {
  const token = `flk_${"b".repeat(43)}`;
  machineRecord = {
    id: `mtk_${"d".repeat(32)}`,
    userId: "machine-owner",
    expiresAt: new Date(Date.now() - 1),
    revokedAt: null,
  };
  await expect(
    AuthService.requireAgentUserIdFromHeaders({ authorization: `Bearer ${token}` }),
  ).rejects.toMatchObject({ code: 401 });

  machineRecord = {
    id: `mtk_${"d".repeat(32)}`,
    userId: "machine-owner",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: new Date(),
  };
  await expect(
    AuthService.requireAgentUserIdFromHeaders({ authorization: `Bearer ${token}` }),
  ).rejects.toMatchObject({ code: 401 });

  const lookupsBeforeMalformed = machineLookups;
  await expect(
    AuthService.requireAgentUserIdFromHeaders({ authorization: "Bearer flk_too-short" }),
  ).rejects.toMatchObject({ code: 401 });
  expect(machineLookups).toBe(lookupsBeforeMalformed);
});

test("human-only authentication requires a session cookie", async () => {
  await expect(
    AuthService.requireHumanSessionUserIdFromHeaders({
      authorization: "Bearer operator-session",
    }),
  ).rejects.toMatchObject({ code: 401 });

  await expect(
    AuthService.requireHumanSessionUserIdFromHeaders({
      cookie: "session_token=operator-session",
    }),
  ).resolves.toBe("liveoperator");
});

test("credential and approval issuance routes reject unauthenticated and bearer-only callers", async () => {
  const requests = [
    new Request("http://localhost/api/machine-tokens/"),
    new Request("http://localhost/api/machine-tokens/", {
      headers: { authorization: "Bearer operator-session" },
    }),
    new Request("http://localhost/v1/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server_id: "srv_alpha",
        rule_set_version: 7,
        content_digest: `sha256:${"a".repeat(64)}`,
        issued_to: "liveoperator",
      }),
    }),
    new Request("http://localhost/v1/approvals", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        server_id: "srv_alpha",
        rule_set_version: 7,
        content_digest: `sha256:${"a".repeat(64)}`,
        issued_to: "liveoperator",
      }),
    }),
  ];

  for (const request of requests) {
    const response = await humanAuthorityApp.handle(request);
    expect(response.status).toBe(401);
  }
});

test("MOCK_USER_ID cannot bypass session auth", async () => {
  sessionRecord = null;
  process.env.MOCK_USER_ID = "must-not-authorize";

  await expect(AuthService.requireUserId("", "Bearer anything")).rejects.toMatchObject({
    code: 401,
  });
});
