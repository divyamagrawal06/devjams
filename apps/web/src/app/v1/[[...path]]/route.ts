import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listLiveServers, liveApi } from "@/lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

function joinPath(path: string[] | undefined): string {
  return `/${(path ?? []).join("/")}`;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authResult = await getSession(request.headers);
  if (authResult.response) return authResult.response;
  const session = authResult.session;
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });

  const pathname = joinPath((await context.params).path);

  if (pathname === "/servers") {
    try {
      const data = await listLiveServers(session.session.token);
      return Response.json({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "live API error";
      return Response.json({ error: message }, { status: 502 });
    }
  }

  const serverMatch = pathname.match(/^\/servers\/([^/]+)$/);
  if (serverMatch) {
    const response = await liveApi(
      `/api/servers/${encodeURIComponent(serverMatch[1])}`,
      session.session.token,
    );
    const body = await response.json();
    return Response.json(body, { status: response.status });
  }

  return Response.json(
    {
      error: "not_available",
      message: `${request.method} /v1${pathname} has no authenticated upstream connector yet.`,
    },
    { status: 501 },
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authResult = await getSession(request.headers);
  if (authResult.response) return authResult.response;
  const session = authResult.session;
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });

  const pathname = joinPath((await context.params).path);

  return Response.json(
    {
      error: "not_available",
      message: `${request.method} /v1${pathname} has no authenticated upstream connector yet.`,
    },
    { status: 501 },
  );
}
