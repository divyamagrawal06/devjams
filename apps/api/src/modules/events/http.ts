import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { ServerService } from "../servers/service";
import { createDurableEventStream, parseReplayCursor } from "./service";

export async function canReplayServerEvents(
  userId: string,
  serverId: string,
  ownsServer: (userId: string, serverId: string) => Promise<boolean> = ServerService.hasOwnership,
): Promise<boolean> {
  return ownsServer(userId, serverId);
}

export const eventStreamModule = new Elysia({ name: "durable-event-stream" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserIdFromHeaders(headers),
  }))
  .get("/api/servers/:serverId/events", async ({ userId, params, headers, request, set }) => {
    if (!(await canReplayServerEvents(userId, params.serverId))) {
      set.status = 404;
      return { error: "Server not found" };
    }

    let cursor: number;
    try {
      cursor = parseReplayCursor(headers["last-event-id"]);
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Invalid Last-Event-ID" };
    }

    return new Response(
      createDurableEventStream(params.serverId, cursor, { signal: request.signal }),
      {
        headers: {
          "cache-control": "private, no-cache, no-store, must-revalidate",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        },
      },
    );
  });
