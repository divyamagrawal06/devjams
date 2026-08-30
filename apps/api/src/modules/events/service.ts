import { type SseEvent, toSseFrame } from "@farlands/contracts";
import { controlPlaneEvents } from "@repo/db";
import { and, asc, eq, gt } from "drizzle-orm";

import { db } from "../../db";

export type DurableEventType = "change_submitted" | "change_reviewed" | "deployment_state";

export type DurableEventRow = {
  id: number;
  serverId: string;
  type: DurableEventType;
  data: Record<string, unknown>;
  createdAt: Date;
};

export function parseReplayCursor(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new Error("Last-Event-ID must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Last-Event-ID is outside the safe range");
  return parsed;
}

export function durableEventFrame(row: DurableEventRow): string {
  return toSseFrame({
    id: String(row.id),
    type: row.type,
    server_id: row.serverId,
    ts: row.createdAt.toISOString(),
    data: row.data,
  } as SseEvent);
}

export interface DurableEventReader {
  listAfter(serverId: string, afterId: number, limit?: number): Promise<DurableEventRow[]>;
}

export const eventLedger: DurableEventReader = {
  async listAfter(serverId, afterId, limit = 200) {
    const rows = await db
      .select()
      .from(controlPlaneEvents)
      .where(and(eq(controlPlaneEvents.serverId, serverId), gt(controlPlaneEvents.id, afterId)))
      .orderBy(asc(controlPlaneEvents.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows as DurableEventRow[];
  },
};

function waitForPoll(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    timeout = setTimeout(finish, milliseconds);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createDurableEventStream(
  serverId: string,
  initialCursor: number,
  options: {
    reader?: DurableEventReader;
    signal?: AbortSignal;
    pollMs?: number;
    lifetimeMs?: number;
    now?: () => number;
  } = {},
): ReadableStream<Uint8Array> {
  const reader = options.reader ?? eventLedger;
  const pollMs = options.pollMs ?? 1_000;
  const lifetimeMs = options.lifetimeMs ?? 25_000;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  let clientCancelled = false;
  let aborted = options.signal?.aborted ?? false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = initialCursor;
      const deadline = now() + lifetimeMs;
      controller.enqueue(encoder.encode("retry: 2000\n\n"));

      const abort = () => {
        aborted = true;
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      try {
        while (!clientCancelled && !aborted && now() < deadline) {
          const events = await reader.listAfter(serverId, cursor);
          if (clientCancelled || aborted) break;

          for (const event of events) {
            if (clientCancelled || aborted) break;
            controller.enqueue(encoder.encode(durableEventFrame(event)));
            cursor = event.id;
          }

          if (events.length === 0 && !clientCancelled && !aborted) {
            controller.enqueue(encoder.encode(`: heartbeat ${new Date(now()).toISOString()}\n\n`));
          }

          if (clientCancelled || aborted || now() >= deadline) break;
          await waitForPoll(pollMs, options.signal);
        }
      } finally {
        options.signal?.removeEventListener("abort", abort);
        if (!clientCancelled) controller.close();
      }
    },
    cancel() {
      clientCancelled = true;
    },
  });
}
