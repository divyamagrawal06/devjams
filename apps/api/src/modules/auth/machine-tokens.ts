import { randomUUID } from "node:crypto";
import { TOKEN_PREFIX } from "@farlands/contracts";
import { machineTokens } from "@repo/db";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../db";
import { generateOpaqueToken, hashOpaqueToken } from "./tokens";

const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;
const TOKEN_GENERATION_ATTEMPTS = 3;

export type StoredMachineToken = {
  tokenHash: string;
  id: string;
  userId: string;
  name: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

export type MachineTokenRepository = {
  insert(record: StoredMachineToken): Promise<boolean>;
  list(userId: string): Promise<Omit<StoredMachineToken, "tokenHash" | "userId">[]>;
  revoke(userId: string, id: string, revokedAt: Date): Promise<boolean>;
  ownsActive(userId: string, id: string, now: Date): Promise<boolean>;
};

const drizzleMachineTokenRepository: MachineTokenRepository = {
  async insert(record) {
    const inserted = await db
      .insert(machineTokens)
      .values(record)
      .onConflictDoNothing()
      .returning({ id: machineTokens.id });
    return inserted.length === 1;
  },

  async list(userId) {
    return db
      .select({
        id: machineTokens.id,
        name: machineTokens.name,
        expiresAt: machineTokens.expiresAt,
        revokedAt: machineTokens.revokedAt,
        createdAt: machineTokens.createdAt,
      })
      .from(machineTokens)
      .where(eq(machineTokens.userId, userId))
      .orderBy(desc(machineTokens.createdAt));
  },

  async revoke(userId, id, revokedAt) {
    const revoked = await db
      .update(machineTokens)
      .set({ revokedAt })
      .where(
        and(
          eq(machineTokens.userId, userId),
          eq(machineTokens.id, id),
          isNull(machineTokens.revokedAt),
        ),
      )
      .returning({ id: machineTokens.id });
    return revoked.length === 1;
  },

  async ownsActive(userId, id, now) {
    const record = await db.query.machineTokens.findFirst({
      where: and(
        eq(machineTokens.userId, userId),
        eq(machineTokens.id, id),
        isNull(machineTokens.revokedAt),
      ),
      columns: { expiresAt: true },
    });
    return Boolean(record && record.expiresAt > now);
  },
};

type MachineTokenDependencies = {
  now(): Date;
  entropy(size: number): Uint8Array;
  id(): string;
};

export class MachineTokenService {
  constructor(
    private readonly repository: MachineTokenRepository = drizzleMachineTokenRepository,
    private readonly dependencies: MachineTokenDependencies = {
      now: () => new Date(),
      entropy: (size) => crypto.getRandomValues(new Uint8Array(size)),
      id: () => `mtk_${randomUUID().replaceAll("-", "")}`,
    },
  ) {}

  async mint(input: { userId: string; name: string; expiresInDays?: number }) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error("Machine token name must be 1-80 characters");
    const expiresInDays = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
      throw new Error(`Machine token expiry must be 1-${MAX_EXPIRY_DAYS} days`);
    }

    const now = this.dependencies.now();
    const expiresAt = new Date(now.getTime() + expiresInDays * 86_400_000);
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const token = generateOpaqueToken(TOKEN_PREFIX.machine, this.dependencies.entropy);
      const id = this.dependencies.id();
      const inserted = await this.repository.insert({
        tokenHash: hashOpaqueToken(token),
        id,
        userId: input.userId,
        name,
        expiresAt,
        revokedAt: null,
        createdAt: now,
      });
      if (inserted) return { id, token, name, expiresAt, createdAt: now };
    }
    throw new Error("Could not allocate a unique machine token");
  }

  async list(userId: string) {
    const now = this.dependencies.now();
    const records = await this.repository.list(userId);
    return records.map((record) => ({
      ...record,
      active: !record.revokedAt && record.expiresAt > now,
    }));
  }

  revoke(userId: string, id: string) {
    return this.repository.revoke(userId, id, this.dependencies.now());
  }

  canReceiveApproval(userId: string, principalId: string) {
    if (principalId === userId) return Promise.resolve(true);
    return this.repository.ownsActive(userId, principalId, this.dependencies.now());
  }
}

export const machineTokenService = new MachineTokenService();
