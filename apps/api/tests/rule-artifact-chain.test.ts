import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertCandidateArtifactCompatibility,
  buildArtifactLoader,
} from "../src/modules/provisioning/candidate";

const originalLoaderImage = process.env.FARLANDS_ARTIFACT_FETCH_IMAGE;

afterEach(() => {
  if (originalLoaderImage === undefined) delete process.env.FARLANDS_ARTIFACT_FETCH_IMAGE;
  else process.env.FARLANDS_ARTIFACT_FETCH_IMAGE = originalLoaderImage;
});

describe("candidate artifact loading", () => {
  const artifact = {
    artifactUrl: "s3://immutable-rules/write-once/rules.jar",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    artifactRuntimeVersion: "1.20.4",
  };

  test("mounts the same URI and verifies the full digest before the atomic rename", () => {
    process.env.FARLANDS_ARTIFACT_FETCH_IMAGE = `public.ecr.aws/aws-cli/aws-cli@sha256:${"0".repeat(64)}`;
    const loader = buildArtifactLoader(artifact);
    expect(loader.env).toContainEqual({ name: "ARTIFACT_URI", value: artifact.artifactUrl });
    expect(loader.env).toContainEqual({
      name: "ARTIFACT_SHA256",
      value: artifact.artifactDigest.slice(7),
    });
    expect(loader.command.join("\n")).toMatch(/sha256sum -c/);
    expect(loader.command.join("\n")).toMatch(/\.partial.*farlands-rules\.jar/s);
  });

  test("fails closed for mutable locations, latest runtimes, and version drift", () => {
    expect(() =>
      assertCandidateArtifactCompatibility({ ...artifact, serverRuntimeVersion: "1.20.4" }),
    ).not.toThrow();
    expect(() =>
      assertCandidateArtifactCompatibility({
        ...artifact,
        artifactUrl: "https://example.test/rules.jar",
        serverRuntimeVersion: "1.20.4",
      }),
    ).toThrow(/immutable s3/);
    expect(() =>
      assertCandidateArtifactCompatibility({ ...artifact, serverRuntimeVersion: "latest" }),
    ).toThrow(/pinned/);
    expect(() =>
      assertCandidateArtifactCompatibility({ ...artifact, serverRuntimeVersion: "1.21.1" }),
    ).toThrow(/incompatible/);
  });
});

test("rule versions and artifacts are database-enforced append-only records", () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "db",
      "migrations",
      "0008_rule_artifact_provenance.sql",
    ),
    "utf8",
  );
  expect(migration).toContain('CREATE TABLE "rule_set_versions"');
  expect(migration).toContain('CREATE TABLE "rule_artifacts"');
  expect(migration).toContain("rule_set_versions_append_only");
  expect(migration).toContain("rule_artifacts_append_only");
  expect(migration).not.toContain("source_prompt");
});

test("M1 harness uses the corrected HTTP tar protocol and exact freeze order", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const measurement = readFileSync(join(root, "infra", "k8s", "world-sync", "measure.py"), "utf8");
  const tenancy = readFileSync(
    join(root, "apps", "api", "src", "modules", "provisioning", "tenancy.ts"),
    "utf8",
  );
  expect(tenancy).toContain('urllib.request.Request(SOURCE + query, data=b"", method="POST")');
  expect(tenancy).toContain("archive.extractall(path=ROOT, filter=extraction_filter)");
  expect(measurement.indexOf('rcon.command("save-off")')).toBeLessThan(
    measurement.indexOf('rcon.command("save-all flush")'),
  );
  expect(measurement.indexOf('rcon.command("save-all flush")')).toBeLessThan(
    measurement.indexOf("delta_ms = transfer"),
  );
  expect(measurement.indexOf("delta_ms = transfer")).toBeLessThan(
    measurement.indexOf('rcon.command("save-on")'),
  );
  expect(measurement).toContain('"status": "unmeasured"');
  expect(measurement).toContain("MIN_REALISTIC_WORLD_BYTES");
});
