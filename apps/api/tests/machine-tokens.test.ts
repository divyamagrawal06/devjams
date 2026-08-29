import { describe, expect, test } from "bun:test";

import {
  type MachineTokenRepository,
  MachineTokenService,
  type StoredMachineToken,
} from "../src/modules/auth/machine-tokens";
import { hashOpaqueToken } from "../src/modules/auth/tokens";

class MemoryMachineTokenRepository implements MachineTokenRepository {
  readonly records = new Map<string, StoredMachineToken>();

  async insert(record: StoredMachineToken) {
    if (this.records.has(record.tokenHash)) return false;
    this.records.set(record.tokenHash, { ...record });
    return true;
  }

  async list(userId: string) {
    return [...this.records.values()]
      .filter((record) => record.userId === userId)
      .map(({ tokenHash: _tokenHash, userId: _userId, ...record }) => ({ ...record }));
  }

  async revoke(userId: string, id: string, revokedAt: Date) {
    const record = [...this.records.values()].find(
      (candidate) => candidate.userId === userId && candidate.id === id && !candidate.revokedAt,
    );
    if (!record) return false;
    record.revokedAt = revokedAt;
    return true;
  }

  async ownsActive(userId: string, id: string, now: Date) {
    return [...this.records.values()].some(
      (record) =>
        record.userId === userId && record.id === id && !record.revokedAt && record.expiresAt > now,
    );
  }
}

function fixture() {
  const repository = new MemoryMachineTokenRepository();
  let now = new Date("2026-08-30T12:00:00.000Z");
  const service = new MachineTokenService(repository, {
    now: () => now,
    entropy: (size) => Uint8Array.from({ length: size }, (_, index) => 255 - index),
    id: () => `mtk_${"a".repeat(32)}`,
  });
  return {
    repository,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe("machine token lifecycle", () => {
  test("returns the flk secret once and persists only its hash", async () => {
    const { repository, service } = fixture();
    const minted = await service.mint({ userId: "owner", name: "Hosted MCP" });

    expect(minted.token).toMatch(/^flk_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(minted)).not.toContain("tokenHash");
    const stored = [...repository.records.values()][0];
    expect(stored?.tokenHash).toBe(hashOpaqueToken(minted.token));
    expect(JSON.stringify(stored)).not.toContain(minted.token);
  });

  test("lists safe metadata and supports owner-scoped revocation", async () => {
    const { service } = fixture();
    const minted = await service.mint({ userId: "owner", name: "Hosted MCP", expiresInDays: 7 });

    const listed = await service.list("owner");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: minted.id, name: "Hosted MCP", active: true });
    expect(Object.keys(listed[0] ?? {})).not.toContain("tokenHash");
    await expect(service.canReceiveApproval("owner", minted.id)).resolves.toBe(true);
    await expect(service.canReceiveApproval("someone-else", minted.id)).resolves.toBe(false);
    await expect(service.revoke("someone-else", minted.id)).resolves.toBe(false);
    await expect(service.revoke("owner", minted.id)).resolves.toBe(true);
    expect((await service.list("owner"))[0]?.active).toBe(false);
    await expect(service.canReceiveApproval("owner", minted.id)).resolves.toBe(false);
  });

  test("marks expired credentials inactive and bounds their lifetime", async () => {
    const { service, setNow } = fixture();
    await service.mint({ userId: "owner", name: "Short lived", expiresInDays: 1 });
    setNow("2026-08-31T12:00:00.001Z");
    expect((await service.list("owner"))[0]?.active).toBe(false);

    await expect(
      service.mint({ userId: "owner", name: "Invalid", expiresInDays: 0 }),
    ).rejects.toThrow(/1-365 days/);
    await expect(
      service.mint({ userId: "owner", name: "Invalid", expiresInDays: 366 }),
    ).rejects.toThrow(/1-365 days/);
  });
});
