import { Elysia } from "elysia";
import { z } from "zod";

export const changeDraftDto = z.object({
  serverId: z.string().min(1).max(128),
  title: z.string().trim().min(3).max(120),
  rationale: z.string().trim().min(1).max(2000),
  document: z.unknown(),
});

export const changeRejectDto = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export type ChangeDraftInput = z.infer<typeof changeDraftDto>;
export type ChangeRejectInput = z.infer<typeof changeRejectDto>;

export const ChangesModel = new Elysia({ name: "changes.model" }).model({
  "changes.create": changeDraftDto,
  "changes.reject": changeRejectDto,
});
