import {
  controlPlaneEvents,
  maintenanceWindows,
  notificationPreferences,
  operatorReceipts,
} from "@repo/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { db } from "../../db";
import { AuthService } from "../auth/service";
import { ServerService } from "../servers/service";

const maintenanceInput = z.object({
  serverId: z.string().min(1).max(128),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(480),
  action: z.enum(["restart", "operator_work"]),
  reason: z.string().trim().min(3).max(500),
});

const notificationInput = z.object({
  deploymentEvents: z.boolean(),
  backupEvents: z.boolean(),
  billingEvents: z.boolean(),
  maintenanceEvents: z.boolean(),
  timezone: z.string().trim().min(1).max(64),
});

export function maintenanceBounds(
  startsAt: Date,
  now = new Date(),
): "valid" | "too_soon" | "too_far" {
  if (startsAt.getTime() < now.getTime() + 5 * 60_000) return "too_soon";
  if (startsAt.getTime() > now.getTime() + 90 * 24 * 60 * 60_000) return "too_far";
  return "valid";
}

export function windowsOverlap(
  left: { startsAt: Date; durationMinutes: number },
  right: { startsAt: Date; durationMinutes: number },
): boolean {
  const leftEnd = left.startsAt.getTime() + left.durationMinutes * 60_000;
  const rightEnd = right.startsAt.getTime() + right.durationMinutes * 60_000;
  return left.startsAt.getTime() < rightEnd && right.startsAt.getTime() < leftEnd;
}

function validTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function publicReceipt(row: typeof operatorReceipts.$inferSelect) {
  return {
    id: row.id,
    serverId: row.serverId,
    requestKey: row.requestKey,
    action: row.action,
    status: row.status,
    observedState: row.observedState,
    acceptedAt: row.acceptedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function publicWindow(row: typeof maintenanceWindows.$inferSelect) {
  return {
    id: row.id,
    serverId: row.serverId,
    startsAt: row.startsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    action: row.action,
    status: row.status,
    reason: row.reason,
  };
}

const defaultPreferences = {
  deploymentEvents: true,
  backupEvents: true,
  billingEvents: true,
  maintenanceEvents: true,
  timezone: "UTC",
};

export const operatorModule = new Elysia({ prefix: "/api/operator", name: "operator" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserIdFromHeaders(headers),
  }))
  .get("/", async ({ userId }) => {
    const [receipts, windows, preferences] = await Promise.all([
      db
        .select()
        .from(operatorReceipts)
        .where(eq(operatorReceipts.userId, userId))
        .orderBy(desc(operatorReceipts.acceptedAt))
        .limit(50),
      db
        .select()
        .from(maintenanceWindows)
        .where(
          and(
            eq(maintenanceWindows.userId, userId),
            eq(maintenanceWindows.status, "scheduled"),
            gt(maintenanceWindows.startsAt, new Date()),
          ),
        )
        .orderBy(maintenanceWindows.startsAt)
        .limit(50),
      db.query.notificationPreferences.findFirst({
        where: eq(notificationPreferences.userId, userId),
      }),
    ]);
    return {
      success: true,
      data: {
        receipts: receipts.map(publicReceipt),
        maintenanceWindows: windows.map(publicWindow),
        notificationPreferences: preferences
          ? {
              deploymentEvents: preferences.deploymentEvents,
              backupEvents: preferences.backupEvents,
              billingEvents: preferences.billingEvents,
              maintenanceEvents: preferences.maintenanceEvents,
              timezone: preferences.timezone,
            }
          : defaultPreferences,
        delivery: {
          inApp: true,
          email: "unavailable",
          push: "unavailable",
        },
      },
    };
  })
  .put("/notifications", async ({ headers, body, set }) => {
    const userId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
    const parsed = notificationInput.safeParse(body);
    if (!parsed.success || !validTimezone(parsed.data.timezone)) {
      set.status = 400;
      return { success: false, error: "Notification preferences are invalid." };
    }
    await db
      .insert(notificationPreferences)
      .values({ userId, ...parsed.data })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { ...parsed.data, updatedAt: new Date() },
      });
    return { success: true, data: parsed.data };
  })
  .post("/maintenance", async ({ headers, body, set }) => {
    const userId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
    const parsed = maintenanceInput.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { success: false, error: "Maintenance window is invalid." };
    }
    const startsAt = new Date(parsed.data.startsAt);
    const bounds = maintenanceBounds(startsAt);
    if (bounds !== "valid") {
      set.status = 400;
      return {
        success: false,
        error:
          bounds === "too_soon"
            ? "Maintenance must start at least five minutes from now."
            : "Maintenance cannot be scheduled more than 90 days ahead.",
      };
    }
    await ServerService.requireOwnership(userId, parsed.data.serverId);

    const created = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`maintenance:${parsed.data.serverId}`}))`,
      );
      const existing = await tx
        .select({
          startsAt: maintenanceWindows.startsAt,
          durationMinutes: maintenanceWindows.durationMinutes,
        })
        .from(maintenanceWindows)
        .where(
          and(
            eq(maintenanceWindows.serverId, parsed.data.serverId),
            eq(maintenanceWindows.status, "scheduled"),
          ),
        );
      if (
        existing.some((window) =>
          windowsOverlap(window, { startsAt, durationMinutes: parsed.data.durationMinutes }),
        )
      ) {
        return null;
      }

      const id = `mnt_${crypto.randomUUID().replaceAll("-", "")}`;
      const [row] = await tx
        .insert(maintenanceWindows)
        .values({
          id,
          userId,
          serverId: parsed.data.serverId,
          startsAt,
          durationMinutes: parsed.data.durationMinutes,
          action: parsed.data.action,
          reason: parsed.data.reason,
        })
        .returning();
      await tx.insert(controlPlaneEvents).values({
        serverId: parsed.data.serverId,
        type: "maintenance_scheduled",
        data: {
          maintenance_id: id,
          starts_at: startsAt.toISOString(),
          duration_minutes: parsed.data.durationMinutes,
          action: parsed.data.action,
        },
      });
      return row;
    });
    if (!created) {
      set.status = 409;
      return { success: false, error: "This workload already has overlapping maintenance." };
    }
    set.status = 201;
    return { success: true, data: publicWindow(created) };
  })
  .delete("/maintenance/:id", async ({ headers, params, set }) => {
    const userId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
    const result = await db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(maintenanceWindows)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(maintenanceWindows.id, params.id),
            eq(maintenanceWindows.userId, userId),
            eq(maintenanceWindows.status, "scheduled"),
            gt(maintenanceWindows.startsAt, new Date()),
          ),
        )
        .returning();
      if (!cancelled) return null;
      await tx.insert(controlPlaneEvents).values({
        serverId: cancelled.serverId,
        type: "maintenance_cancelled",
        data: { maintenance_id: cancelled.id },
      });
      return cancelled;
    });
    if (!result) {
      set.status = 404;
      return { success: false, error: "Scheduled maintenance was not found." };
    }
    return { success: true, data: publicWindow(result) };
  });
