import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { upstreamSessionCookie } from "@/lib/auth-cookie";
import { connectorOriginAllowed, connectorPathAllowed } from "@/lib/connector-policy";

export const runtime = "nodejs";
export const maxDuration = 300;

const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "if-match", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-disposition",
  "content-type",
  "etag",
  "location",
  "x-request-id",
];
function requestOriginAllowed(request: NextRequest): boolean {
  return connectorOriginAllowed({
    method: request.method,
    origin: request.headers.get("origin"),
    requestOrigin: request.nextUrl.origin,
    configuredOrigin: process.env.BETTER_AUTH_URL?.trim(),
    production: process.env.NODE_ENV === "production",
  });
}

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!requestOriginAllowed(request)) {
    return Response.json({ error: "Untrusted request origin" }, { status: 403 });
  }

  const pathname = `/${path.map(encodeURIComponent).join("/")}`;
  if (!connectorPathAllowed(pathname)) {
    return Response.json({ error: "Connector path is not allowed" }, { status: 404 });
  }

  const base = process.env.LIVE_API_URL?.trim().replace(/\/$/, "");
  if (!base) {
    return Response.json(
      { error: "The live control-plane connector is not configured." },
      { status: 503 },
    );
  }

  const search = request.nextUrl.search;
  const url = `${base}${pathname}${search}`;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("cookie", upstreamSessionCookie(session.session.token));

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "private, no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Farlands connector request failed", {
      path: pathname,
      message: error instanceof Error ? error.message : "Unknown connector error",
    });
    return Response.json(
      { error: "The live control plane is currently unreachable." },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}
