"use client";

import { CircleAlert, RefreshCw, ScrollText, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { farlandsApiPath, type LiveServer } from "@/lib/api";
import {
  type ControlPlaneEvent,
  controlEventSummary,
  mergeControlPlaneEvent,
  parseControlPlaneEvent,
} from "@/lib/control-events";

type StreamState = "connecting" | "live" | "reconnecting";

function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function TrustLedgerWindow({
  controlMessage,
  controlsAvailable,
  servers,
}: {
  controlMessage: string;
  controlsAvailable: boolean;
  servers: LiveServer[];
}) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [events, setEvents] = useState<ControlPlaneEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [generation, setGeneration] = useState(0);
  const selected = useMemo(
    () => servers.find((server) => server.id === serverId) ?? servers[0] ?? null,
    [serverId, servers],
  );
  const selectedId = selected?.id ?? "";

  useEffect(() => {
    if (!serverId && servers[0]) setServerId(servers[0].id);
  }, [serverId, servers]);

  useEffect(() => {
    if (!selectedId || !controlsAvailable) {
      setStreamState("reconnecting");
      return;
    }
    setEvents([]);
    setStreamState("connecting");
    const source = new EventSource(
      `${farlandsApiPath(`/api/servers/${encodeURIComponent(selectedId)}/events`)}?reconnect=${generation}`,
    );
    const receive = (message: MessageEvent<string>) => {
      const event = parseControlPlaneEvent(message.data);
      if (!event || event.server_id !== selectedId) return;
      setEvents((current) => mergeControlPlaneEvent(current, event));
      setStreamState("live");
    };
    source.addEventListener("change_submitted", receive as EventListener);
    source.addEventListener("change_reviewed", receive as EventListener);
    source.addEventListener("deployment_state", receive as EventListener);
    source.onopen = () => setStreamState("live");
    source.onerror = () => setStreamState("reconnecting");
    return () => source.close();
  }, [controlsAvailable, generation, selectedId]);

  if (!selected) {
    return (
      <div className="query-state">
        <ScrollText aria-hidden="true" size={27} />
        <div>
          <h3>No workload ledger is available</h3>
          <p>Receipts appear after a workload is assigned to this account.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ledger-view">
      <div className="window-hero ledger-hero">
        <p className="eyebrow">Restart-safe control-plane truth</p>
        <h2>Trust Ledger</h2>
        <p>
          Draft, review, and deployment receipts replay from durable storage. Raw chat, player
          names, and world activity are not part of this stream.
        </p>
      </div>

      {!controlsAvailable ? (
        <div className="control-truth-banner" role="status">
          <CircleAlert aria-hidden="true" size={17} /> {controlMessage} Showing replayed receipts
          only.
        </div>
      ) : null}

      <div className="ledger-toolbar">
        <label>
          Workload
          <select onChange={(event) => setServerId(event.target.value)} value={selected.id}>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
        <div className={`ledger-connection ${streamState}`} role="status">
          <span aria-hidden="true" />
          {streamState === "live"
            ? "Live durable stream"
            : streamState === "reconnecting"
              ? "Reconnecting from last receipt"
              : "Replaying receipts"}
        </div>
        <button
          aria-label="Reconnect receipt stream"
          className="operation-secondary-action"
          onClick={() => setGeneration((value) => value + 1)}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} /> Reconnect
        </button>
      </div>

      <div className="ledger-scope-note">
        <CircleAlert aria-hidden="true" size={18} />
        <span>
          World Feed remains unavailable until privacy-aware telemetry rollups are connected. This
          window shows operational evidence only and does not infer player activity.
        </span>
      </div>

      {events.length === 0 ? (
        <div className="query-state">
          <ShieldCheck aria-hidden="true" size={26} />
          <div>
            <h3>No operational receipts yet</h3>
            <p>The connection is real; this workload simply has no connected change history.</p>
          </div>
        </div>
      ) : (
        <ol className="ledger-list" aria-live="polite">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <span className="ledger-sequence">#{event.id}</span>
              <div>
                <strong>{controlEventSummary(event)}</strong>
                <span>{event.type.replaceAll("_", " ")}</span>
              </div>
              <time dateTime={event.ts}>{timestamp(event.ts)}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
