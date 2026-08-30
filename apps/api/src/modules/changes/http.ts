import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { ChangesModel } from "./model";
import { ChangeOperationError, ChangeService, type ChangeStatus } from "./service";

function operationFailure(error: unknown, set: { status?: number | string }) {
  if (error instanceof ChangeOperationError) {
    set.status = error.status;
    return { success: false, error: error.message };
  }
  console.error("Connected change operation failed", error);
  set.status = 500;
  return { success: false, error: "The change operation could not be completed." };
}

export const changesModule = new Elysia({ prefix: "/api/changes", name: "connected-changes" })
  .use(ChangesModel)
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserIdFromHeaders(headers),
  }))
  .get("/", async ({ userId, query, set }) => {
    const status = query.status as ChangeStatus | undefined;
    if (status && !["pending_review", "approved", "rejected"].includes(status)) {
      set.status = 400;
      return { success: false, error: "Invalid change status" };
    }
    try {
      return { success: true, data: await ChangeService.list(userId, status) };
    } catch (error) {
      return operationFailure(error, set);
    }
  })
  .get("/:id", async ({ userId, params, set }) => {
    try {
      return { success: true, data: await ChangeService.get(userId, params.id) };
    } catch (error) {
      return operationFailure(error, set);
    }
  })
  .post(
    "/",
    async ({ headers, body, set }) => {
      const humanUserId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
      try {
        const data = await ChangeService.create(humanUserId, body);
        set.status = 201;
        return { success: true, data };
      } catch (error) {
        return operationFailure(error, set);
      }
    },
    { body: "changes.create" },
  )
  .post("/:id/approve", async ({ headers, params, set }) => {
    const humanUserId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
    try {
      return {
        success: true,
        data: await ChangeService.approve(humanUserId, params.id, headers["if-match"]),
      };
    } catch (error) {
      return operationFailure(error, set);
    }
  })
  .post(
    "/:id/reject",
    async ({ headers, params, body, set }) => {
      const humanUserId = await AuthService.requireHumanSessionUserIdFromHeaders(headers);
      try {
        return {
          success: true,
          data: await ChangeService.reject(humanUserId, params.id, body.reason),
        };
      } catch (error) {
        return operationFailure(error, set);
      }
    },
    { body: "changes.reject" },
  );
