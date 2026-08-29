import { createHash, timingSafeEqual } from "node:crypto";

export type InternalAuthResult = "authorized" | "unconfigured" | "unauthorized";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyInternalServiceRequest(
  headers: Record<string, string | undefined>,
  configuredKey = process.env.INTERNAL_API_KEY,
): InternalAuthResult {
  if (!configuredKey?.trim()) return "unconfigured";
  const providedKey = headers["x-internal-key"];
  if (!providedKey) return "unauthorized";
  return timingSafeEqual(digest(providedKey), digest(configuredKey))
    ? "authorized"
    : "unauthorized";
}

export function internalAuthRefusal(result: Exclude<InternalAuthResult, "authorized">) {
  return result === "unconfigured"
    ? { status: 503 as const, body: { error: "Internal service authentication is not configured" } }
    : { status: 401 as const, body: { error: "Unauthorized" } };
}
