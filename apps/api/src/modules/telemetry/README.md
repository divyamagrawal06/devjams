# telemetry

Owned by Engineer 1. Ingest at `POST /internal/telemetry/:serverId`, then rolling window
aggregation into `world_events_rollup`.

Raw events are not stored. Everything downstream reads rollups.

## Shape

| File | Responsibility |
|---|---|
| `plugin.ts` | The Elysia plugin. Mount with `app.use(telemetryPlugin({ store }))`. |
| `guard.ts` | Refuses requests carrying edge-proxy forwarding headers. |
| `events.ts` | NDJSON parsing and validation compiled from the `WorldEvent` contract. |
| `window.ts` | One open window's counters. No event is ever held. |
| `sessions.ts` | Join/leave pairing and the two window-boundary decisions. |
| `aggregator.ts` | Window rotation, HMAC pseudonymisation, and durable reduction. |
| `checkpoint.ts` | Versioned aggregate-only crash-recovery state. |
| `store.ts` | Atomic rollup, checkpoint, and emitter-cursor persistence. |

## The rules this module is built to keep

**No raw events, anywhere.** Before state crosses the persistence boundary, player names are
replaced with stable HMAC tokens. The crash checkpoint contains counters, HMAC-token sets,
open-session timestamps, and per-region totals—never raw events, names, or chat content.
Memory and storage are functions of distinct players and elapsed windows, never event volume.
Set `TELEMETRY_PRIVACY_KEY` to a stable secret so internal-service key rotation does not change
tokens mid-session; deployments without it use `INTERNAL_API_KEY` as a fail-closed fallback.

**Cluster-internal is enforced in layers.** The NetworkPolicy limits reachability, this module
refuses edge-forwarding headers, and every request must carry the shared `x-internal-key`.
Missing production configuration fails closed with 503. An accidentally proxied request still
gets `not_found`, so a scanner does not learn that `/internal/*` exists.

**Session pairing at a window boundary.** A session still open when a window closes is
carried forward, not truncated, and the full duration is credited to the window in which the
session actually closed. A leave with no join counts toward `leaves` and contributes nothing
to `mean_session_seconds`. `mean_session_seconds` is `null`, never `0`, when nothing closed.
`sessions.ts` states the reasoning; `test/telemetry-rollup.test.ts` asserts both cases.

**Player names are opaque and ephemeral.** Nothing parses, logs, or branches on them. The
HTTP boundary converts them to HMAC tokens before checkpoint reduction, and the rejection
path reports schema paths rather than values.

**Acknowledgement is durable and idempotent.** Each emitter boot has a UUID and a strictly
increasing sequence. The same sequence and payload digest reuses its committed receipt;
conflicting retries and gaps fail closed. The cursor, open checkpoint, and any closed rollups
commit in one transaction before HTTP success, so an ambiguous response retry counts once.

## Production wiring

`DrizzleRollupStore` writes immutable closed windows plus aggregate-only open checkpoints. The
Paper emitter uses a bounded queue and Java's asynchronous HTTP client; retries retain the same
cursor identity, it never sends chat content, and shutdown never performs network I/O on the
game thread.
