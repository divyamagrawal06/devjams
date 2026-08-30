import { createHmac } from "node:crypto";
import { ServerId } from "@farlands/contracts";
import { Elysia, getSchemaValidator } from "elysia";
import { internalAuthRefusal, verifyInternalServiceRequest } from "../auth/internal-service";
import { type AggregatorOptions, TelemetryAggregator } from "./aggregator.ts";
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, parseNdjsonBatch } from "./events.ts";
import { externalRoutingHeader, internalOnlyRefusal } from "./guard.ts";
import { TelemetryBatchConflictError, TelemetrySequenceError } from "./store.ts";

/**
 * `POST /internal/telemetry/:serverId`.
 *
 * Shipped as a plugin rather than as an application so the shell owner mounts
 * it (`app.use(telemetryPlugin({ store }))`) without this module having an
 * opinion about ports, middleware order or anything else outside its seam.
 *
 * Three properties the handler is built around:
 *
 *   1. It acknowledges only after aggregate state and the emitter cursor are
 *      committed together. The bounded async emitter retries a 503 without
 *      ever blocking the game thread.
 *   2. It cannot accept an event the contract forbids. The validator is
 *      compiled from `WorldEvent` itself, not restated.
 *   3. It treats every string in the payload as opaque. Player names are
 *      counted and never read; not by the handler, not by the aggregator, and
 *      not by the error path, which reports schema paths rather than values.
 */

const serverIdValidator = getSchemaValidator(ServerId, {});

export interface TelemetryPluginOptions extends AggregatorOptions {
  /** Supply an aggregator to share one instance across routes. */
  aggregator?: TelemetryAggregator;
  /** Injected by tests; production defaults to INTERNAL_API_KEY and fails closed when absent. */
  internalKey?: string;
  /** Stable HMAC secret for player pseudonyms; defaults to the internal key. */
  privacyKey?: string;
  /** Close quiet windows on a bounded cadence. */
  flushIntervalMs?: number;
}

export interface TelemetryIngestResponse {
  server_id: string;
  emitter_id: string;
  sequence: number;
  reused: boolean;
  accepted: number;
  rejected: number;
  /** Events whose window had already closed. Non-zero means batches are out of order. */
  late: number;
  /** Capped detail for the rejected lines, by line number and schema path. */
  rejections: { line: number; path: string; expected: string }[];
}

export function telemetryPlugin(options: TelemetryPluginOptions) {
  const aggregator = options.aggregator ?? new TelemetryAggregator(options);
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  return new Elysia({ name: "farlands-telemetry" })
    .decorate("telemetry", aggregator)
    .onStart(() => {
      flushTimer = setInterval(() => {
        void aggregator.flushExpired().catch((error) => {
          console.error("Telemetry flush failed", {
            message: error instanceof Error ? error.message : "Unknown flush error",
          });
        });
      }, options.flushIntervalMs ?? 60_000);
      flushTimer.unref?.();
    })
    .onStop(() => {
      if (flushTimer) clearInterval(flushTimer);
      // Every acknowledged open window is already checkpointed. Closing it
      // during a rolling API restart would make the rest of that still-open
      // absolute window look late to the replacement process.
    })
    .post(
      "/internal/telemetry/:serverId",
      async ({ params, request, headers, set }) => {
        // The guard runs before anything reads the body, so an externally
        // routed request costs one header lookup rather than a parse.
        const forwarded = externalRoutingHeader(headers);
        if (forwarded !== null) {
          set.status = 404;
          return internalOnlyRefusal(forwarded);
        }

        const authResult = verifyInternalServiceRequest(headers, options.internalKey);
        if (authResult !== "authorized") {
          const refusal = internalAuthRefusal(authResult);
          set.status = refusal.status;
          return refusal.body;
        }

        const emitterId = headers["x-telemetry-emitter-id"];
        const sequenceText = headers["x-telemetry-sequence"];
        const sequence = sequenceText && /^\d+$/.test(sequenceText) ? Number(sequenceText) : 0;
        if (
          !emitterId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            emitterId,
          ) ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1
        ) {
          set.status = 400;
          return {
            error: "invalid_telemetry_cursor" as const,
            message: "Telemetry batches require a valid emitter id and positive sequence.",
          };
        }

        // A path segment becomes a store key, so it is validated against the
        // contract's ServerId rather than trusted because it came from a router.
        if (!serverIdValidator.Check(params.serverId)) {
          set.status = 404;
          return {
            error: "not_found" as const,
            tool: "telemetry_ingest",
            resource: "server",
            message: "That server id is not a valid server id.",
            resolution:
              "Post to /internal/telemetry/{server_id} using the id issued for the world.",
          };
        }

        const body = await request.text();
        if (body.length > MAX_BATCH_BYTES) {
          set.status = 413;
          return {
            error: "batch_too_large" as const,
            limit_bytes: MAX_BATCH_BYTES,
            limit_events: MAX_BATCH_EVENTS,
            message: "Telemetry batch exceeded the size limit and was not read.",
            resolution: `Send at most ${MAX_BATCH_EVENTS} events per batch.`,
          };
        }

        const batch = parseNdjsonBatch(body);
        if (batch.oversized) {
          set.status = 413;
          return {
            error: "batch_too_large" as const,
            limit_bytes: MAX_BATCH_BYTES,
            limit_events: MAX_BATCH_EVENTS,
            message: "Telemetry batch exceeded the event limit and was not read.",
            resolution: `Send at most ${MAX_BATCH_EVENTS} events per batch.`,
          };
        }

        const privacyKey =
          options.privacyKey?.trim() ||
          process.env.TELEMETRY_PRIVACY_KEY?.trim() ||
          options.internalKey?.trim() ||
          process.env.INTERNAL_API_KEY?.trim();
        if (!privacyKey) {
          set.status = 503;
          return { error: "Telemetry privacy key is not configured" };
        }

        let outcome;
        try {
          outcome = await aggregator.ingestDurably({
            serverId: params.serverId,
            emitterId,
            sequence,
            // Key the digest as well: an unkeyed hash of a tiny player-name
            // batch would be vulnerable to an offline dictionary guess.
            payloadDigest: createHmac("sha256", privacyKey)
              .update("telemetry-payload:v1\0", "utf8")
              .update(body, "utf8")
              .digest("hex"),
            privacyKey,
            events: batch.events,
          });
        } catch (error) {
          if (
            error instanceof TelemetryBatchConflictError ||
            error instanceof TelemetrySequenceError
          ) {
            set.status = 409;
            return {
              error: "telemetry_cursor_conflict" as const,
              message: error.message,
            };
          }
          set.status = 503;
          return {
            error: "telemetry_store_unavailable" as const,
            message: "Telemetry was not acknowledged; retry this exact batch.",
          };
        }

        const response: TelemetryIngestResponse = {
          server_id: params.serverId,
          emitter_id: emitterId,
          sequence,
          reused: outcome.reused,
          accepted: outcome.accepted,
          rejected: batch.rejections.length,
          late: outcome.late,
          rejections: batch.rejections,
        };

        // Partial success stays a 200 because one bad line in a batch of a
        // hundred is not a failed request. A batch that produced nothing usable
        // is a different outcome and says so, so a broken emitter is visible
        // instead of looking like a quiet world.
        if (outcome.accepted === 0 && batch.rejections.length > 0) set.status = 422;

        return response;
      },
      // NDJSON is not a shape Elysia's body parsers understand, and the
      // emitter's content-type must not decide whether a batch is readable.
      // Reading the request directly makes the route indifferent to it.
      { parse: "none" },
    );
}

export type TelemetryPlugin = ReturnType<typeof telemetryPlugin>;
