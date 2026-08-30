import type { WorldEventsRollup } from "@farlands/contracts";

export interface WindowCheckpoint {
  start_ms: number;
  end_ms: number;
  joins: number;
  leaves: number;
  deaths: number;
  blocks_placed: number;
  blocks_broken: number;
  chat_messages: number;
  closed_session_seconds: number;
  closed_sessions: number;
  /** HMAC tokens only; raw player names never enter a checkpoint. */
  players: string[];
  seconds_in_region: Array<[string, number]>;
}

export interface TelemetryServerCheckpoint {
  version: 1;
  open: WindowCheckpoint | null;
  /** HMAC token and join time pairs. */
  sessions: Array<[string, number]>;
  last_closed_start_ms: number | null;
}

export interface DurableIngestReceipt {
  accepted: number;
  late: number;
  closed: number;
}

export interface TelemetryStateMutation {
  checkpoint: TelemetryServerCheckpoint;
  rollups: WorldEventsRollup[];
}

export interface TelemetryBatchMutation extends TelemetryStateMutation {
  receipt: DurableIngestReceipt;
}

export const EMPTY_TELEMETRY_CHECKPOINT: TelemetryServerCheckpoint = {
  version: 1,
  open: null,
  sessions: [],
  last_closed_start_ms: null,
};
