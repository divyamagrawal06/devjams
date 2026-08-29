import { upstreamSessionCookie } from "./auth-cookie";

type LiveServer = {
  id: string;
  name: string;
  currentState: string;
  desiredState?: string;
  statusMessage?: string | null;
  version?: string | null;
  hostname?: string | null;
  port?: number | null;
};

function deploymentState(currentState: string): string {
  switch (currentState) {
    case "provisioning":
    case "starting":
      return "staging";
    case "stopping":
      return "draining";
    case "failed":
      return "failed";
    case "running":
    case "ready":
      return "idle";
    default:
      return "idle";
  }
}

export function toSummary(server: LiveServer) {
  const address = server.hostname ? `${server.hostname}:${server.port ?? 25565}` : null;
  return {
    id: server.id,
    name: server.name,
    address,
    currentState: server.currentState,
    deploymentState: deploymentState(server.currentState),
    version: server.version ?? null,
    statusMessage: server.statusMessage ?? null,
  };
}

export async function liveApi(
  path: string,
  sessionToken: string,
  init?: RequestInit,
): Promise<Response> {
  const liveApiUrl = process.env.LIVE_API_URL?.trim().replace(/\/$/, "");
  if (!liveApiUrl) {
    return Response.json(
      { error: "The live control-plane connector is not configured." },
      { status: 503 },
    );
  }

  try {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("cookie", upstreamSessionCookie(sessionToken));

    return await fetch(`${liveApiUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    console.error("Live API request failed", {
      path,
      message: error instanceof Error ? error.message : "fetch failed",
    });
    return Response.json(
      { error: "The live control plane is currently unreachable." },
      { status: 502 },
    );
  }
}

export async function listLiveServers(sessionToken: string) {
  const response = await liveApi("/api/servers", sessionToken);
  const body = (await response.json()) as { data?: LiveServer[]; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `live API ${response.status}`);
  }
  return (body.data ?? []).map(toSummary);
}
