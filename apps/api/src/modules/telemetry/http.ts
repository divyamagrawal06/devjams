import { EMPTY_ROLLUP_METRICS, notFound, type WorldEventsRollup } from "@farlands/contracts";
import { Elysia, t } from "elysia";

import { AuthService } from "../auth/service";
import { mergeRollups } from "../evaluation/metrics";
import { ServerService } from "../servers/service";
import type { RollupStore } from "./store";

export const TELEMETRY_WINDOWS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
} as const;
export type TelemetryWindow = keyof typeof TELEMETRY_WINDOWS;

const PRIVACY_NOTICE =
  "Aggregate counters only. Raw events, chat content, and player names are not retained.";

export function summarizeWorldFeed(
  serverId: string,
  window: TelemetryWindow,
  rollups: readonly WorldEventsRollup[],
  observedAt = new Date(),
) {
  const merged = mergeRollups(rollups);
  return {
    server_id: serverId,
    window,
    available: merged !== null,
    window_start: merged?.start ?? null,
    window_end: merged?.end ?? null,
    metrics: merged?.metrics ?? null,
    rollup_windows: merged?.windows ?? 0,
    observed_at: observedAt.toISOString(),
    privacy: PRIVACY_NOTICE,
    unique_players_is_lower_bound: true,
  };
}

async function responseFor(
  store: RollupStore,
  input: { serverId: string; userId: string; window: TelemetryWindow },
) {
  if (!(await ServerService.hasOwnership(input.userId, input.serverId))) return null;
  const now = new Date();
  const since = new Date(now.getTime() - TELEMETRY_WINDOWS[input.window]);
  // Five-minute windows make 288 rows the maximum for 24h. The small margin
  // allows a boundary window without turning this into an unbounded read.
  const rollups = await store.list(input.serverId, { since, limit: 300 });
  return summarizeWorldFeed(input.serverId, input.window, rollups, now);
}

const querySchema = t.Object(
  {
    window: t.Optional(t.Union([t.Literal("1h"), t.Literal("6h"), t.Literal("24h")])),
  },
  { additionalProperties: false },
);

export function createTelemetryReadModule(store: RollupStore) {
  const module = new Elysia({ name: "telemetry-read" }).derive(async ({ headers }) => ({
    identity: await AuthService.requireAgentIdentityFromHeaders(headers),
  }));

  const handler = async ({
    identity,
    params,
    query,
    set,
  }: {
    identity: { userId: string };
    params: { serverId: string };
    query: { window?: TelemetryWindow };
    set: { status?: number | string };
  }) => {
    const result = await responseFor(store, {
      serverId: params.serverId,
      userId: identity.userId,
      window: query.window ?? "1h",
    });
    if (!result) {
      set.status = 404;
      return notFound({ tool: "get_world_telemetry", resource: `server ${params.serverId}` });
    }
    return result;
  };

  return module
    .get(
      "/v1/servers/:id/telemetry",
      ({ identity, params, query, set }) =>
        handler({ identity, params: { serverId: params.id }, query, set }),
      { query: querySchema },
    )
    .get("/api/servers/:serverId/telemetry", handler, { query: querySchema });
}

/** Stable empty shape for clients that need an initial skeleton without inventing activity. */
export const EMPTY_WORLD_FEED_METRICS = EMPTY_ROLLUP_METRICS;
