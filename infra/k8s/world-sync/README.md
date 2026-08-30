# M1 world-sync measurement

`measure.py` is the falsification harness for the player-visible freeze window. It
runs against a real live server A and a candidate PVC B; it does not contain sample
timings and it refuses to label undersized worlds as measured.

Required inputs are `SOURCE_SYNC_URL`, `DEST_WORLD`, `RCON_HOST`,
`RCON_PASSWORD_FILE`, `CANDIDATE_START_URL`, `CANDIDATE_READY_URL`,
`CANDIDATE_DEPLOYMENT_ID`, and `CANDIDATE_ARTIFACT_DIGEST`. Set
`PLAYERS_DRAINED=true` only after Velocity reports that the source-realm roster is
empty. The default realistic-world floor is 1 GiB and can be raised with
`MIN_REALISTIC_WORLD_BYTES`.

The readiness URL must be an internal `.svc.cluster.local` HTTP endpoint. It
must return `application/json` with the exact shape
`{"status":"ready","deployment_id":"...","artifact_digest":"sha256:..."}`.
The harness rejects generic 2xx responses and identity mismatches, so a stale
or incorrectly targeted service can never publish a measured result.

The deployment sync path writes the source server's nanosecond snapshot-start
boundary into the candidate PVC during presync. The frozen delta reads that
marker and compares it with source-host `mtime_ns`; API-host wall-clock time is
audit metadata only and is never used to decide which world files changed.

The result is one JSON record. Preserve it with `--output` in the measurement job's
durable result volume or CI artifact. Until a real cluster run produces that record,
all product surfaces must continue to report the freeze estimate as `unmeasured`.
