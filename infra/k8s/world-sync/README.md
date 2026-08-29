# M1 world-sync measurement

`measure.py` is the falsification harness for the player-visible freeze window. It
runs against a real live server A and a candidate PVC B; it does not contain sample
timings and it refuses to label undersized worlds as measured.

Required inputs are `SOURCE_SYNC_URL`, `DEST_WORLD`, `RCON_HOST`,
`RCON_PASSWORD_FILE`, `CANDIDATE_START_URL`, and `CANDIDATE_READY_URL`. Set
`PLAYERS_DRAINED=true` only after Velocity reports that the source-realm roster is
empty. The default realistic-world floor is 1 GiB and can be raised with
`MIN_REALISTIC_WORLD_BYTES`.

The result is one JSON record. Preserve it with `--output` in the measurement job's
durable result volume or CI artifact. Until a real cluster run produces that record,
all product surfaces must continue to report the freeze estimate as `unmeasured`.
