import {
  contentDigest,
  type VelocityTransfer,
  type VelocityTransferAck,
} from "@farlands/contracts";
import { velocityTransfers } from "@repo/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import { db } from "../../db";

const DEFAULT_TRANSFER_TTL_MS = 2 * 60 * 1000;

export type TransferStatus = "pending" | "acked" | "expired";

export type TransferRecord = VelocityTransfer & {
  deploymentId: string;
  sourcePlayers: string[];
  status: TransferStatus;
  attempts: number;
  ack: VelocityTransferAck | null;
  acknowledgedAt: string | null;
  createdAt: string;
};

export interface TransferStore {
  insert(record: TransferRecord): Promise<TransferRecord>;
  listPending(now: Date): Promise<TransferRecord[]>;
  find(id: string): Promise<TransferRecord | null>;
  acknowledge(id: string, ack: VelocityTransferAck, now: Date): Promise<TransferRecord | null>;
}

type TransferRow = typeof velocityTransfers.$inferSelect;

function toRecord(row: TransferRow): TransferRecord {
  return {
    transferId: row.id,
    deploymentId: row.deploymentId,
    fromRoute: row.fromRoute,
    toRoute: row.toRoute,
    message: row.message,
    players: row.sourcePlayers,
    expiresAt: row.expiresAt.toISOString(),
    attempt: row.attempts,
    sourcePlayers: row.sourcePlayers,
    status: row.status as TransferStatus,
    attempts: row.attempts,
    ack: row.ack ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleTransferStore implements TransferStore {
  async insert(record: TransferRecord): Promise<TransferRecord> {
    await db
      .insert(velocityTransfers)
      .values({
        id: record.transferId,
        deploymentId: record.deploymentId,
        fromRoute: record.fromRoute,
        toRoute: record.toRoute,
        message: record.message,
        sourcePlayers: record.sourcePlayers,
        status: record.status,
        attempts: record.attempts,
        ack: record.ack,
        expiresAt: new Date(record.expiresAt),
        acknowledgedAt: record.acknowledgedAt ? new Date(record.acknowledgedAt) : null,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoNothing();
    const stored = await this.find(record.transferId);
    if (!stored) throw new Error("Transfer insert did not return a durable row");
    if (
      stored.deploymentId !== record.deploymentId ||
      stored.fromRoute !== record.fromRoute ||
      stored.toRoute !== record.toRoute ||
      stored.message !== record.message ||
      contentDigest(stored.sourcePlayers) !== contentDigest(record.sourcePlayers)
    ) {
      throw new Error("Transfer idempotency key conflicts with different transfer content");
    }
    return stored;
  }

  async listPending(now: Date): Promise<TransferRecord[]> {
    await db
      .update(velocityTransfers)
      .set({ status: "expired", updatedAt: sql`now()` })
      .where(
        and(eq(velocityTransfers.status, "pending"), sql`${velocityTransfers.expiresAt} <= ${now}`),
      );
    const rows = await db
      .update(velocityTransfers)
      .set({ attempts: sql`${velocityTransfers.attempts} + 1`, updatedAt: sql`now()` })
      .where(and(eq(velocityTransfers.status, "pending"), gt(velocityTransfers.expiresAt, now)))
      .returning();
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toRecord);
  }

  async find(id: string): Promise<TransferRecord | null> {
    const row = await db.query.velocityTransfers.findFirst({
      where: eq(velocityTransfers.id, id),
    });
    return row ? toRecord(row) : null;
  }

  async acknowledge(
    id: string,
    ack: VelocityTransferAck,
    now: Date,
  ): Promise<TransferRecord | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(velocityTransfers)
        .where(eq(velocityTransfers.id, id))
        .for("update");
      if (!row) return null;
      if (row.status === "pending" && row.expiresAt <= now) {
        const [expired] = await tx
          .update(velocityTransfers)
          .set({ status: "expired", updatedAt: sql`now()` })
          .where(eq(velocityTransfers.id, id))
          .returning();
        return expired ? toRecord(expired) : null;
      }
      if (row.status !== "pending") return toRecord(row);
      const [updated] = await tx
        .update(velocityTransfers)
        .set({
          status: "acked",
          ack,
          acknowledgedAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(velocityTransfers.id, id))
        .returning();
      return updated ? toRecord(updated) : null;
    });
  }
}

export class MemoryTransferStore implements TransferStore {
  readonly records = new Map<string, TransferRecord>();

  async insert(record: TransferRecord): Promise<TransferRecord> {
    const existing = this.records.get(record.transferId);
    if (existing) {
      if (
        existing.deploymentId !== record.deploymentId ||
        existing.fromRoute !== record.fromRoute ||
        existing.toRoute !== record.toRoute ||
        existing.message !== record.message ||
        contentDigest(existing.sourcePlayers) !== contentDigest(record.sourcePlayers)
      ) {
        throw new Error("Transfer idempotency key conflicts with different transfer content");
      }
      return { ...existing };
    }
    this.records.set(record.transferId, structuredClone(record));
    return structuredClone(record);
  }

  async listPending(now: Date): Promise<TransferRecord[]> {
    const pending: TransferRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (new Date(record.expiresAt) <= now) {
        record.status = "expired";
        continue;
      }
      record.attempts += 1;
      record.attempt = record.attempts;
      pending.push(structuredClone(record));
    }
    return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async find(id: string): Promise<TransferRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async acknowledge(
    id: string,
    ack: VelocityTransferAck,
    now: Date,
  ): Promise<TransferRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.status === "pending" && new Date(record.expiresAt) <= now) {
      record.status = "expired";
      return structuredClone(record);
    }
    if (record.status !== "pending") return structuredClone(record);
    record.status = "acked";
    record.ack = structuredClone(ack);
    record.acknowledgedAt = now.toISOString();
    return structuredClone(record);
  }
}

function normalizedPlayers(players: string[]): string[] {
  return [...new Set(players.map((player) => player.trim()).filter(Boolean))].sort();
}

function transferId(input: {
  deploymentId: string;
  fromRoute: string;
  toRoute: string;
  message: string;
  sourcePlayers: string[];
}): string {
  return `tx_${contentDigest(input).slice("sha256:".length, "sha256:".length + 32)}`;
}

export class TransferService {
  constructor(
    private readonly store: TransferStore = new DrizzleTransferStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    deploymentId: string;
    fromRoute: string;
    toRoute: string;
    message: string;
    sourcePlayers: string[];
    expiresInMs?: number;
  }): Promise<string> {
    const sourcePlayers = normalizedPlayers(input.sourcePlayers);
    const now = this.now();
    const expiresInMs = input.expiresInMs ?? DEFAULT_TRANSFER_TTL_MS;
    if (!Number.isInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > 10 * 60 * 1000) {
      throw new Error("Transfer expiry must be between 1 ms and 10 minutes");
    }
    const id = transferId({
      deploymentId: input.deploymentId,
      fromRoute: input.fromRoute,
      toRoute: input.toRoute,
      message: input.message,
      sourcePlayers,
    });
    await this.store.insert({
      transferId: id,
      deploymentId: input.deploymentId,
      fromRoute: input.fromRoute,
      toRoute: input.toRoute,
      message: input.message,
      players: sourcePlayers,
      sourcePlayers,
      expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
      attempt: 0,
      status: "pending",
      attempts: 0,
      ack: null,
      acknowledgedAt: null,
      createdAt: now.toISOString(),
    });
    return id;
  }

  async listPending(): Promise<VelocityTransfer[]> {
    return (await this.store.listPending(this.now())).map((record) => ({
      transferId: record.transferId,
      fromRoute: record.fromRoute,
      toRoute: record.toRoute,
      message: record.message,
      players: record.sourcePlayers,
      expiresAt: record.expiresAt,
      attempt: record.attempts,
    }));
  }

  async acknowledge(id: string, ack: VelocityTransferAck): Promise<VelocityTransferAck> {
    const existing = await this.store.find(id);
    if (!existing) throw new Error("Unknown transfer");
    const normalizedAck = {
      movedPlayers: normalizedPlayers(ack.movedPlayers),
      failures: [...ack.failures]
        .map((failure) => ({ player: failure.player.trim(), reason: failure.reason.trim() }))
        .filter((failure) => failure.player && failure.reason)
        .sort((a, b) => a.player.localeCompare(b.player)),
    };
    const sourcePlayers = new Set(existing.sourcePlayers);
    const reported = [
      ...normalizedAck.movedPlayers,
      ...normalizedAck.failures.map((failure) => failure.player),
    ];
    if (reported.some((player) => !sourcePlayers.has(player))) {
      throw new Error("Transfer acknowledgement includes a player outside the source realm");
    }
    if (new Set(reported).size !== reported.length) {
      throw new Error("Transfer acknowledgement reports a player more than once");
    }

    if (existing.status === "acked") {
      if (contentDigest(existing.ack) !== contentDigest(normalizedAck)) {
        throw new Error("Transfer was already acknowledged with different content");
      }
      return existing.ack!;
    }
    if (existing.status === "expired" || new Date(existing.expiresAt) <= this.now()) {
      await this.store.acknowledge(id, normalizedAck, this.now());
      throw new Error("Transfer has expired");
    }
    const updated = await this.store.acknowledge(id, normalizedAck, this.now());
    if (updated?.status !== "acked" || !updated.ack) {
      throw new Error("Transfer acknowledgement could not be persisted");
    }
    if (contentDigest(updated.ack) !== contentDigest(normalizedAck)) {
      throw new Error("Transfer was already acknowledged with different content");
    }
    return updated.ack;
  }

  async waitForAck(
    id: string,
    timeoutMs = 60_000,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ): Promise<VelocityTransferAck> {
    const deadline = this.now().getTime() + timeoutMs;
    while (this.now().getTime() < deadline) {
      const row = await this.store.find(id);
      if (!row) throw new Error("Unknown transfer");
      if (row.status === "acked" && row.ack) return row.ack;
      if (row.status === "expired")
        throw new Error(`Transfer ${id} expired before acknowledgement`);
      await wait(Math.min(250, Math.max(1, deadline - this.now().getTime())));
    }
    throw new Error(`Timed out waiting for transfer ack ${id}`);
  }
}

export const transferService = new TransferService();
