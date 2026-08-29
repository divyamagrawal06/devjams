import { describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { buildRuleJar, type ImmutableArtifactStore, validatePluginBuilderBody } from "../index";
import { sha256Digest } from "../storage";

class MemoryArtifactStore implements ImmutableArtifactStore {
  readonly values = new Map<string, Uint8Array>();

  async putOnce(key: string, body: Uint8Array): Promise<string> {
    const previous = this.values.get(key);
    if (previous && !Buffer.from(previous).equals(Buffer.from(body))) {
      throw new Error(`collision: ${key}`);
    }
    this.values.set(key, new Uint8Array(body));
    return `memory://${key}`;
  }
}

function runtimeBytes(): Uint8Array {
  const zip = new AdmZip();
  zip.addFile("com/farlands/PluginMain.class", Buffer.from("reviewed-runtime"));
  zip.addFile("config.yml", Buffer.from("old: true"));
  zip.addFile("plugin.yml", Buffer.from("name: Farlands"));
  return zip.toBuffer();
}

const reviewedRuntimeBytes = runtimeBytes();
const runtime = {
  bytes: reviewedRuntimeBytes,
  digest: sha256Digest(reviewedRuntimeBytes),
  minecraftVersion: "1.20.4",
};

function document(message = "Welcome") {
  return {
    metadata: { pluginName: "SafeRules", minecraftVersion: "1.20.4" },
    onPlayerJoin: { privateMessage: message },
  };
}

describe("immutable rule artifacts", () => {
  test("builds deterministic bytes and content-addressed locations", async () => {
    const store = new MemoryArtifactStore();
    const first = await buildRuleJar(document(), { runtime, store });
    const second = await buildRuleJar(document(), { runtime, store });

    expect(second).toEqual(first);
    expect(first.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.artifactDigest).not.toBe(first.contentDigest);
    expect(first.jarUrl).toContain(first.artifactDigest.slice(7));
    expect(first.jsonUrl).toContain(first.contentDigest.slice(7));

    const storedJar = store.values.get(first.jarUrl.replace("memory://", ""));
    expect(storedJar).toBeDefined();
    const jar = new AdmZip(Buffer.from(storedJar ?? []));
    expect(jar.readAsText("config.yml")).toContain("Welcome");
    expect(jar.readAsText("plugin.yml")).toContain("api-version: 1.20");
  });

  test("changes the loaded artifact digest when reviewed content changes", async () => {
    const store = new MemoryArtifactStore();
    const before = await buildRuleJar(document("Welcome"), { runtime, store });
    const after = await buildRuleJar(document("Welcome back"), { runtime, store });
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.artifactDigest).not.toBe(before.artifactDigest);
  });

  test("rejects runtime drift and stateful rule vocabulary", async () => {
    await expect(
      buildRuleJar(document(), {
        runtime: { ...runtime, digest: `sha256:${"f".repeat(64)}` },
        store: new MemoryArtifactStore(),
      }),
    ).rejects.toThrow(/runtime digest mismatch/);
    await expect(
      buildRuleJar(
        { ...document(), metadata: { pluginName: "SafeRules", minecraftVersion: "1.21.1" } },
        { runtime, store: new MemoryArtifactStore() },
      ),
    ).rejects.toThrow(/runtime is pinned/);
    expect(validatePluginBuilderBody({ ...document(), counters: { joins: 0 } })).toEqual({
      ok: false,
      error: "rule.counters is stateful and cannot survive a backend handover",
    });
  });
});
