export const CONTROL_FRESHNESS_MS = 30_000;

export type ConnectorState = "checking" | "connected" | "unavailable";
export type ControlTruthState = "verified" | "checking" | "offline" | "unavailable" | "stale";

export type ControlTruth = {
  canMutate: boolean;
  message: string;
  state: ControlTruthState;
};

export function evaluateControlTruth({
  connectorState,
  maxAgeMs = CONTROL_FRESHNESS_MS,
  now,
  observedAt,
  online,
}: {
  connectorState: ConnectorState;
  maxAgeMs?: number;
  now: number;
  observedAt: number;
  online: boolean;
}): ControlTruth {
  if (!online) {
    return {
      canMutate: false,
      message: "Offline — cached controls are locked.",
      state: "offline",
    };
  }
  if (connectorState === "unavailable") {
    return {
      canMutate: false,
      message: "Connector unavailable — cached controls are locked.",
      state: "unavailable",
    };
  }
  if (connectorState === "checking" || observedAt <= 0) {
    return {
      canMutate: false,
      message: "Verifying live control-plane state…",
      state: "checking",
    };
  }
  if (now - observedAt > maxAgeMs) {
    return {
      canMutate: false,
      message: "Live state is stale — refresh before using controls.",
      state: "stale",
    };
  }
  return { canMutate: true, message: "Live state verified.", state: "verified" };
}
