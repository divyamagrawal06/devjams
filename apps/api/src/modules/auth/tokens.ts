import { createHash, randomBytes } from "node:crypto";
import type { TOKEN_PREFIX } from "@farlands/contracts";

const TOKEN_BYTES = 32;
const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type OpaqueTokenPrefix = (typeof TOKEN_PREFIX)[keyof typeof TOKEN_PREFIX];

export function isOpaqueToken(value: string, prefix: OpaqueTokenPrefix): boolean {
  return value.startsWith(prefix) && TOKEN_BODY_PATTERN.test(value.slice(prefix.length));
}

export function hashOpaqueToken(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function generateOpaqueToken(
  prefix: OpaqueTokenPrefix,
  entropy: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = entropy(TOKEN_BYTES);
  if (bytes.byteLength !== TOKEN_BYTES) {
    throw new Error(`Token entropy source must return exactly ${TOKEN_BYTES} bytes`);
  }
  return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}
