import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, contentDigest } from "@farlands/contracts";
import { buildPluginJar } from "./jar-builder";
import { getRuntimeJar, type RuntimeJar } from "./runtime-jar";
import { artifactStoreFromEnv, type ImmutableArtifactStore, sha256Digest } from "./storage";
import { validatePluginBuilderBody } from "./validation";
import { generateYaml } from "./yaml-generator";

export type BuildRuleJarResult = {
  jarUrl: string;
  jsonUrl: string;
  /** RFC 8785 digest of the validated rule document. */
  contentDigest: string;
  /** SHA-256 of the exact JAR bytes the candidate must load. */
  artifactDigest: string;
  runtimeDigest: string;
  runtimeMinecraftVersion: string;
  artifactSizeBytes: number;
};

export type BuildRuleJarOptions = {
  runtime?: RuntimeJar;
  store?: ImmutableArtifactStore;
};

function assertRuntimeCompatibility(documentVersion: string | undefined, runtimeVersion: string) {
  if (!documentVersion) {
    throw new Error("metadata.minecraftVersion is required for a deployable rule artifact");
  }
  if (documentVersion !== runtimeVersion) {
    throw new Error(
      `Rule document targets Minecraft ${documentVersion}, but runtime is pinned to ${runtimeVersion}`,
    );
  }
}

/** Build and persist one content-addressed, immutable deployable artifact. */
export async function buildRuleJar(
  ruleJson: unknown,
  options: BuildRuleJarOptions = {},
): Promise<BuildRuleJarResult> {
  const validation = validatePluginBuilderBody(ruleJson);
  if (!validation.ok) throw new Error(validation.error);

  const body = JSON.parse(JSON.stringify(validation.value)) as typeof validation.value;
  const runtime = options.runtime ?? (await getRuntimeJar());
  const recomputedRuntimeDigest = sha256Digest(runtime.bytes);
  if (recomputedRuntimeDigest !== runtime.digest) {
    throw new Error(
      `Supplied rule runtime digest mismatch: expected ${runtime.digest}, received ${recomputedRuntimeDigest}`,
    );
  }
  assertRuntimeCompatibility(body.metadata?.minecraftVersion, runtime.minecraftVersion);
  const jarBytes = buildPluginJar(
    validation.pluginName,
    generateYaml(body),
    runtime.bytes,
    runtime.minecraftVersion,
  );
  const canonicalDocument = canonicalize(body);
  const documentDigest = contentDigest(body);
  const artifactDigest = sha256Digest(jarBytes);
  const store = options.store ?? artifactStoreFromEnv();
  const prefix = `write-once/${validation.pluginName}`;
  const jsonUrl = await store.putOnce(
    `${prefix}/${documentDigest.slice("sha256:".length)}.json`,
    Buffer.from(canonicalDocument, "utf8"),
    "application/json",
  );
  const jarUrl = await store.putOnce(
    `${prefix}/${artifactDigest.slice("sha256:".length)}.jar`,
    jarBytes,
    "application/java-archive",
  );

  return {
    jarUrl,
    jsonUrl,
    contentDigest: documentDigest,
    artifactDigest,
    runtimeDigest: runtime.digest,
    runtimeMinecraftVersion: runtime.minecraftVersion,
    artifactSizeBytes: jarBytes.byteLength,
  };
}

export type { RuntimeJar } from "./runtime-jar";
export {
  type ImmutableArtifactStore,
  LocalArtifactStore,
  verifyArtifactBytes,
} from "./storage";
export type { PluginBuilderBody, PotionEffect, StartingItem } from "./types";
export { validatePluginBuilderBody } from "./validation";

const STATIC_JSON = resolve(import.meta.dir, "../../fixtures/rules/static-rule.json");

/** Kept only as an explicit fixture reader; live deployment never falls back to it. */
export function readStaticRule(): unknown {
  return JSON.parse(readFileSync(STATIC_JSON, "utf8")) as unknown;
}
