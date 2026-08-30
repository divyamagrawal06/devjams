export type ControlPlaneEvent = {
  id: string;
  type: "change_submitted" | "change_reviewed" | "deployment_state";
  server_id: string;
  ts: string;
  data: Record<string, unknown>;
};

const SUPPORTED_TYPES = new Set<ControlPlaneEvent["type"]>([
  "change_submitted",
  "change_reviewed",
  "deployment_state",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseControlPlaneEvent(raw: string): ControlPlaneEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value.data)) return null;
    if (
      typeof value.id !== "string" ||
      !/^\d+$/.test(value.id) ||
      !Number.isSafeInteger(Number(value.id)) ||
      typeof value.type !== "string" ||
      !SUPPORTED_TYPES.has(value.type as ControlPlaneEvent["type"]) ||
      typeof value.server_id !== "string" ||
      typeof value.ts !== "string" ||
      Number.isNaN(Date.parse(value.ts))
    ) {
      return null;
    }
    return value as ControlPlaneEvent;
  } catch {
    return null;
  }
}

export function mergeControlPlaneEvent(
  current: readonly ControlPlaneEvent[],
  incoming: ControlPlaneEvent,
  limit = 200,
): ControlPlaneEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  byId.set(incoming.id, incoming);
  return [...byId.values()]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(-Math.max(1, limit));
}

export function controlEventSummary(event: ControlPlaneEvent): string {
  if (event.type === "change_submitted") {
    return `Draft queued: ${String(event.data.title ?? "Untitled change")}`;
  }
  if (event.type === "change_reviewed") {
    const verdict = event.data.verdict === "approved" ? "Approved" : "Rejected";
    return `${verdict} exact artifact ${shortDigest(String(event.data.artifact_digest ?? ""))}`;
  }
  const state = String(event.data.state ?? "unknown").replaceAll("_", " ");
  const detail = typeof event.data.detail === "string" ? ` — ${event.data.detail}` : "";
  return `Deployment ${state}${detail}`;
}

export function shortDigest(digest: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(digest)
    ? `${digest.slice(0, 14)}…${digest.slice(-8)}`
    : "digest unavailable";
}
