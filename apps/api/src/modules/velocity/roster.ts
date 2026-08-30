import { velocityRouteRosters } from "@repo/db";
import { eq, sql } from "drizzle-orm";

import { db } from "../../db";

export type RouteRoster = {
  route: string;
  targetHost: string;
  targetPort: number;
  players: string[];
  observedAt: string;
};

export interface RouteRosterStore {
  upsertMany(records: RouteRoster[]): Promise<void>;
  find(route: string): Promise<RouteRoster | null>;
}

function normalizeToken(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 253 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid Velocity ${field}`);
  }
  return normalized;
}

function normalizePlayers(players: string[]): string[] {
  if (players.length > 10_000) throw new Error("Velocity roster exceeds the safety limit");
  return [...new Set(players.map((player) => normalizeToken(player, "player")))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function toRoster(row: typeof velocityRouteRosters.$inferSelect): RouteRoster {
  return {
    route: row.route,
    targetHost: row.targetHost,
    targetPort: row.targetPort,
    players: row.players,
    observedAt: row.observedAt.toISOString(),
  };
}

export class DrizzleRouteRosterStore implements RouteRosterStore {
  async upsertMany(records: RouteRoster[]): Promise<void> {
    if (!records.length) return;
    await db.transaction(async (tx) => {
      for (const record of records) {
        await tx
          .insert(velocityRouteRosters)
          .values({
            route: record.route,
            targetHost: record.targetHost,
            targetPort: record.targetPort,
            players: record.players,
            observedAt: new Date(record.observedAt),
          })
          .onConflictDoUpdate({
            target: velocityRouteRosters.route,
            set: {
              targetHost: record.targetHost,
              targetPort: record.targetPort,
              players: record.players,
              observedAt: new Date(record.observedAt),
              updatedAt: sql`now()`,
            },
            setWhere: sql`${velocityRouteRosters.observedAt} <= ${new Date(record.observedAt)}`,
          });
      }
    });
  }

  async find(route: string): Promise<RouteRoster | null> {
    const row = await db.query.velocityRouteRosters.findFirst({
      where: eq(velocityRouteRosters.route, route),
    });
    return row ? toRoster(row) : null;
  }
}

export class MemoryRouteRosterStore implements RouteRosterStore {
  readonly records = new Map<string, RouteRoster>();

  async upsertMany(records: RouteRoster[]): Promise<void> {
    for (const record of records) {
      const existing = this.records.get(record.route);
      if (!existing || existing.observedAt <= record.observedAt) {
        this.records.set(record.route, structuredClone(record));
      }
    }
  }

  async find(route: string): Promise<RouteRoster | null> {
    const record = this.records.get(route);
    return record ? structuredClone(record) : null;
  }
}

export class RouteRosterService {
  constructor(
    private readonly store: RouteRosterStore = new DrizzleRouteRosterStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async report(
    routes: Array<{ route: string; targetHost: string; targetPort: number; players: string[] }>,
  ): Promise<{ accepted: number; observedAt: string }> {
    if (routes.length > 2_000) throw new Error("Velocity route report exceeds the safety limit");
    const observedAt = this.now().toISOString();
    const normalized = routes.map((route) => ({
      route: normalizeToken(route.route, "route"),
      targetHost: normalizeToken(route.targetHost, "target host").toLowerCase(),
      targetPort: route.targetPort,
      players: normalizePlayers(route.players),
      observedAt,
    }));
    if (new Set(normalized.map((record) => record.route)).size !== normalized.length) {
      throw new Error("Velocity route report contains a duplicate route");
    }
    await this.store.upsertMany(normalized);
    return { accepted: normalized.length, observedAt };
  }

  async requireFresh(route: string, maxAgeMs = 15_000): Promise<RouteRoster> {
    const record = await this.store.find(route);
    if (!record) throw new Error(`Velocity has not reported route ${route}`);
    const ageMs = this.now().getTime() - new Date(record.observedAt).getTime();
    if (ageMs < 0 || ageMs > maxAgeMs) {
      throw new Error(`Velocity roster for ${route} is stale`);
    }
    return record;
  }

  async waitForTarget(
    input: {
      route: string;
      targetHost: string;
      targetPort: number;
      observedAfter: Date;
      timeoutMs?: number;
      intervalMs?: number;
    },
    wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ): Promise<RouteRoster> {
    const timeoutMs = input.timeoutMs ?? 45_000;
    const intervalMs = input.intervalMs ?? 250;
    const deadline = this.now().getTime() + timeoutMs;
    const expectedHost = input.targetHost.toLowerCase();
    while (this.now().getTime() < deadline) {
      const record = await this.store.find(input.route);
      if (
        record &&
        new Date(record.observedAt) >= input.observedAfter &&
        record.targetHost.toLowerCase() === expectedHost &&
        record.targetPort === input.targetPort
      ) {
        return record;
      }
      await wait(Math.min(intervalMs, Math.max(1, deadline - this.now().getTime())));
    }
    throw new Error(`Timed out waiting for Velocity to register route ${input.route}`);
  }
}

export const routeRosterService = new RouteRosterService();
