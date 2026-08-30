import { deploymentHeadroomReservations } from "@repo/db";
import { count, eq } from "drizzle-orm";

import { db } from "../../db";

export type HeadroomReservation = { deploymentId: string; userId: string; serverId: string };

export interface HeadroomStore {
  reserve(reservation: HeadroomReservation): Promise<void>;
  release(deploymentId: string): Promise<void>;
  countForUser(userId: string): Promise<number>;
}

export class DrizzleHeadroomStore implements HeadroomStore {
  async reserve(reservation: HeadroomReservation): Promise<void> {
    await db.insert(deploymentHeadroomReservations).values(reservation).onConflictDoNothing();
    const stored = await db.query.deploymentHeadroomReservations.findFirst({
      where: eq(deploymentHeadroomReservations.deploymentId, reservation.deploymentId),
    });
    if (
      !stored ||
      stored.userId !== reservation.userId ||
      stored.serverId !== reservation.serverId
    ) {
      throw new Error("Deployment headroom reservation conflicts with its durable owner");
    }
  }

  async release(deploymentId: string): Promise<void> {
    await db
      .delete(deploymentHeadroomReservations)
      .where(eq(deploymentHeadroomReservations.deploymentId, deploymentId));
  }

  async countForUser(userId: string): Promise<number> {
    const [result] = await db
      .select({ value: count() })
      .from(deploymentHeadroomReservations)
      .where(eq(deploymentHeadroomReservations.userId, userId));
    return Number(result?.value ?? 0);
  }
}

export class MemoryHeadroomStore implements HeadroomStore {
  readonly reservations = new Map<string, HeadroomReservation>();

  async reserve(reservation: HeadroomReservation): Promise<void> {
    const existing = this.reservations.get(reservation.deploymentId);
    if (
      existing &&
      (existing.userId !== reservation.userId || existing.serverId !== reservation.serverId)
    ) {
      throw new Error("Deployment headroom reservation conflicts with its durable owner");
    }
    this.reservations.set(reservation.deploymentId, { ...reservation });
  }

  async release(deploymentId: string): Promise<void> {
    this.reservations.delete(deploymentId);
  }

  async countForUser(userId: string): Promise<number> {
    return [...this.reservations.values()].filter((row) => row.userId === userId).length;
  }
}

export const headroomStore: HeadroomStore = new DrizzleHeadroomStore();

export async function reserveDeploymentHeadroom(
  userId: string,
  serverId: string,
  deploymentId: string,
): Promise<void> {
  await headroomStore.reserve({ deploymentId, userId, serverId });
}

export async function releaseDeploymentHeadroom(deploymentId: string): Promise<void> {
  await headroomStore.release(deploymentId);
}

export function headroomHeldByUser(userId: string): Promise<number> {
  return headroomStore.countForUser(userId);
}
