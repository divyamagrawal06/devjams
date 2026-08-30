import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeDeployApprovalMint, ruleApprovalClaim } from "../src/modules/agent/approval-http";
import {
  type ApprovalRepository,
  canonicalApprovalDigest,
  deployRulesApprovalClaim,
  OperationApprovalService,
  powerActionApprovalClaim,
  type StoredApproval,
} from "../src/modules/agent/approvals";
import { hashOpaqueToken } from "../src/modules/auth/tokens";

class MemoryApprovalRepository implements ApprovalRepository {
  readonly records = new Map<string, StoredApproval>();

  async insert(record: StoredApproval) {
    if (this.records.has(record.tokenHash)) return false;
    this.records.set(record.tokenHash, { ...record });
    return true;
  }

  async consume(input: {
    tokenHash: string;
    issuedTo: string;
    operation: string;
    subject: string;
    contentDigest: string;
    now: Date;
  }) {
    const record = this.records.get(input.tokenHash);
    if (
      !record ||
      record.issuedTo !== input.issuedTo ||
      record.operation !== input.operation ||
      record.subject !== input.subject ||
      record.contentDigest !== input.contentDigest ||
      record.expiresAt <= input.now ||
      record.consumedAt
    ) {
      return false;
    }
    record.consumedAt = input.now;
    return true;
  }

  async find(tokenHash: string) {
    return this.records.get(tokenHash) ?? null;
  }
}

function fixture() {
  const repository = new MemoryApprovalRepository();
  let now = new Date("2026-08-30T12:00:00.000Z");
  const service = new OperationApprovalService(repository, {
    now: () => now,
    entropy: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
  });
  return {
    repository,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe("durable operation approvals", () => {
  test("mints one opaque token while persisting only its SHA-256 hash", async () => {
    const { repository, service } = fixture();
    const claim = powerActionApprovalClaim("srv_alpha", "restart");
    const minted = await service.mint({ issuedTo: "owner", issuedBy: "owner", claim });

    expect(minted.token).toMatch(/^apv_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(minted)).not.toContain("tokenHash");
    expect(Object.keys(minted)).not.toContain("contentDigest");
    const stored = [...repository.records.values()][0];
    expect(stored?.tokenHash).toBe(hashOpaqueToken(minted.token));
    expect(JSON.stringify(stored)).not.toContain(minted.token);
  });

  test("uses canonical JSON so object key order does not alter the binding", () => {
    const first = canonicalApprovalDigest({
      operation: "power_action",
      subject: "srv_alpha",
      payload: { nested: { b: 2, a: 1 }, action: "restart" },
    });
    const second = canonicalApprovalDigest({
      operation: "power_action",
      subject: "srv_alpha",
      payload: { action: "restart", nested: { a: 1, b: 2 } },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("allows exactly one concurrent redemption", async () => {
    const { service } = fixture();
    const claim = powerActionApprovalClaim("srv_alpha", "restart");
    const minted = await service.mint({ issuedTo: "owner", issuedBy: "owner", claim });

    const results = await Promise.all([
      service.redeem({ token: minted.token, issuedTo: "owner", claim }),
      service.redeem({ token: minted.token, issuedTo: "owner", claim }),
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result === "consumed")).toHaveLength(1);
  });

  test("does not consume a grant when operation content differs", async () => {
    const { service } = fixture();
    const approved = powerActionApprovalClaim("srv_alpha", "restart");
    const minted = await service.mint({ issuedTo: "owner", issuedBy: "owner", claim: approved });

    await expect(
      service.redeem({
        token: minted.token,
        issuedTo: "owner",
        claim: powerActionApprovalClaim("srv_alpha", "stop"),
      }),
    ).resolves.toBe("digest_mismatch");
    await expect(
      service.redeem({ token: minted.token, issuedTo: "owner", claim: approved }),
    ).resolves.toBeNull();
  });

  test("binds a deploy grant to the exact version, artifact digest, and principal", async () => {
    const { service } = fixture();
    const digest = `sha256:${"a".repeat(64)}`;
    const approved = deployRulesApprovalClaim("srv_alpha", 7, digest);
    const minted = await service.mint({
      issuedTo: `mtk_${"b".repeat(32)}`,
      issuedBy: "owner",
      claim: approved,
    });

    await expect(
      service.redeem({
        token: minted.token,
        issuedTo: `mtk_${"b".repeat(32)}`,
        claim: deployRulesApprovalClaim("srv_alpha", 8, digest),
      }),
    ).resolves.toBe("digest_mismatch");
    await expect(
      service.redeem({
        token: minted.token,
        issuedTo: `mtk_${"b".repeat(32)}`,
        claim: deployRulesApprovalClaim("srv_alpha", 7, `sha256:${"c".repeat(64)}`),
      }),
    ).resolves.toBe("digest_mismatch");
    await expect(
      service.redeem({ token: minted.token, issuedTo: "owner", claim: approved }),
    ).resolves.toBe("principal_mismatch");
    await expect(
      service.redeem({
        token: minted.token,
        issuedTo: `mtk_${"b".repeat(32)}`,
        claim: approved,
      }),
    ).resolves.toBeNull();
  });

  test("can mint a rollback-specific claim without weakening the deploy default", () => {
    const input = {
      server_id: "srv_alpha",
      rule_set_version: 7,
      content_digest: `sha256:${"a".repeat(64)}`,
      issued_to: `mtk_${"b".repeat(32)}`,
    };

    expect(ruleApprovalClaim(input).operation).toBe("deploy_rules");
    expect(ruleApprovalClaim({ ...input, operation: "rollback_rules" }).operation).toBe(
      "rollback_rules",
    );
  });

  test("binds the grant to its principal without spending it on mismatch", async () => {
    const { service } = fixture();
    const claim = powerActionApprovalClaim("srv_alpha", "start");
    const minted = await service.mint({ issuedTo: "owner", issuedBy: "owner", claim });

    await expect(
      service.redeem({ token: minted.token, issuedTo: "someone-else", claim }),
    ).resolves.toBe("principal_mismatch");
    await expect(
      service.redeem({ token: minted.token, issuedTo: "owner", claim }),
    ).resolves.toBeNull();
  });

  test("fails closed for expired, malformed, and unknown grants", async () => {
    const { service, setNow } = fixture();
    const claim = powerActionApprovalClaim("srv_alpha", "stop");
    const minted = await service.mint({ issuedTo: "owner", issuedBy: "owner", claim });
    setNow("2026-08-30T12:06:00.000Z");

    await expect(service.redeem({ token: minted.token, issuedTo: "owner", claim })).resolves.toBe(
      "expired",
    );
    await expect(
      service.redeem({ token: "apv_too-short", issuedTo: "owner", claim }),
    ).resolves.toBe("missing");
    await expect(
      service.redeem({ token: `apv_${"z".repeat(43)}`, issuedTo: "owner", claim }),
    ).resolves.toBe("missing");
  });

  test("mints only for an owned server and an active account principal", async () => {
    const input = {
      server_id: "srv_alpha",
      rule_set_version: 7,
      content_digest: `sha256:${"a".repeat(64)}`,
      issued_to: `mtk_${"b".repeat(32)}`,
    };
    await expect(
      authorizeDeployApprovalMint("owner", input, {
        ownsServer: async () => true,
        canIssueTo: async () => true,
      }),
    ).resolves.toBe("allowed");
    await expect(
      authorizeDeployApprovalMint("owner", input, {
        ownsServer: async () => false,
        canIssueTo: async () => true,
      }),
    ).resolves.toBe("server_not_found");
    await expect(
      authorizeDeployApprovalMint("owner", input, {
        ownsServer: async () => true,
        canIssueTo: async () => false,
      }),
    ).resolves.toBe("invalid_principal");
  });

  test("persists machine recipients without pretending they are user rows", () => {
    const migration = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "packages",
        "db",
        "migrations",
        "0006_active_api_credentials.sql",
      ),
      "utf8",
    );
    expect(migration).toContain('"issued_to" text NOT NULL');
    expect(migration).not.toContain("operation_approvals_issued_to_users_id_fk");
    expect(migration).toContain("operation_approvals_issued_by_users_id_fk");
  });
});
