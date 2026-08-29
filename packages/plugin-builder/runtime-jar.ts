import { readArtifactBytes, sha256Digest } from "./storage";

export type RuntimeJar = {
  bytes: Uint8Array;
  digest: string;
  minecraftVersion: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

let cachedRuntime: { cacheKey: string; value: RuntimeJar } | null = null;

/** Load and verify a reviewed, pinned interpreter release. */
export async function getRuntimeJar(): Promise<RuntimeJar> {
  const uri = requiredEnv("FARLANDS_RULE_RUNTIME_URI");
  const expectedDigest = requiredEnv("FARLANDS_RULE_RUNTIME_SHA256");
  const minecraftVersion = requiredEnv("FARLANDS_RULE_RUNTIME_MINECRAFT_VERSION");
  const cacheKey = `${uri}\u0000${expectedDigest}\u0000${minecraftVersion}`;
  if (cachedRuntime?.cacheKey === cacheKey) {
    return { ...cachedRuntime.value, bytes: new Uint8Array(cachedRuntime.value.bytes) };
  }

  const bytes = await readArtifactBytes(uri);
  if (bytes.byteLength === 0) throw new Error(`Rule runtime was empty at ${uri}`);
  const digest = sha256Digest(bytes);
  if (digest !== expectedDigest) {
    throw new Error(`Rule runtime digest mismatch: expected ${expectedDigest}, received ${digest}`);
  }
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(minecraftVersion)) {
    throw new Error("FARLANDS_RULE_RUNTIME_MINECRAFT_VERSION must be a pinned numeric version");
  }

  const value = { bytes: new Uint8Array(bytes), digest, minecraftVersion };
  cachedRuntime = { cacheKey, value };
  return { ...value, bytes: new Uint8Array(value.bytes) };
}
