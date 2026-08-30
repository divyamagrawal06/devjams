import { describe, expect, test } from "bun:test";

import {
  controlEventSummary,
  mergeControlPlaneEvent,
  parseControlPlaneEvent,
} from "./control-events";

function wire(id: string, type = "deployment_state") {
  return JSON.stringify({
    id,
    type,
    server_id: "srv_alpha",
    ts: "2026-08-30T12:00:00.000Z",
    data: { deployment_id: "dep_alpha", state: "verifying", detail: "digest loaded" },
  });
}

describe("control-plane event client", () => {
  test("parses only the durable connected event vocabulary", () => {
    expect(parseControlPlaneEvent(wire("41"))?.id).toBe("41");
    expect(parseControlPlaneEvent(wire("41", "server_log"))).toBeNull();
    expect(parseControlPlaneEvent("not json")).toBeNull();
    expect(parseControlPlaneEvent(wire("-1"))).toBeNull();
    expect(parseControlPlaneEvent(wire("9007199254740992"))).toBeNull();
  });

  test("deduplicates replay and keeps monotonic order", () => {
    const first = parseControlPlaneEvent(wire("44"));
    const earlier = parseControlPlaneEvent(wire("41"));
    if (!first || !earlier) throw new Error("fixture event did not parse");
    expect(mergeControlPlaneEvent([first], earlier).map((event) => event.id)).toEqual(["41", "44"]);
    expect(mergeControlPlaneEvent([first], first)).toHaveLength(1);
  });

  test("describes receipts without inventing world activity", () => {
    const event = parseControlPlaneEvent(wire("44"));
    if (!event) throw new Error("fixture event did not parse");
    expect(controlEventSummary(event)).toBe("Deployment verifying — digest loaded");
  });
});
