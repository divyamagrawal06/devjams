import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ImmutableArtifactStore {
  putOnce(key: string, body: Uint8Array, contentType: string): Promise<string>;
}

export function sha256Digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function safeKey(key: string): void {
  if (!/^[a-zA-Z0-9._/-]+$/.test(key) || key.startsWith("/") || key.includes("..")) {
    throw new Error(`Invalid artifact key: ${key}`);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return sha256Digest(left) === sha256Digest(right);
}

export class LocalArtifactStore implements ImmutableArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async putOnce(key: string, body: Uint8Array, _contentType: string): Promise<string> {
    safeKey(key);
    const path = resolve(this.root, key);
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path escaped its root");
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, body, { flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!sameBytes(existing, body)) throw new Error(`Write-once artifact collision at ${key}`);
    }
    return pathToFileURL(path).href;
  }
}

function isPreconditionFailure(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}

async function bodyBytes(body: { transformToByteArray(): Promise<Uint8Array> } | undefined) {
  if (!body) throw new Error("Artifact object had no body");
  return body.transformToByteArray();
}

export class S3ArtifactStore implements ImmutableArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(input: { bucket: string; prefix?: string; client?: S3Client }) {
    this.client = input.client ?? new S3Client({});
    this.bucket = input.bucket;
    const prefix = input.prefix ?? "rules/";
    this.prefix = prefix.length === 0 || prefix.endsWith("/") ? prefix : `${prefix}/`;
  }

  async putOnce(key: string, body: Uint8Array, contentType: string): Promise<string> {
    safeKey(key);
    const objectKey = `${this.prefix}${key}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
          CacheControl: "private, immutable, max-age=31536000",
          IfNoneMatch: "*",
          ServerSideEncryption: "AES256",
          Metadata: { sha256: sha256Digest(body).slice("sha256:".length) },
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const existing = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (!sameBytes(await bodyBytes(existing.Body), body)) {
        throw new Error(`Write-once artifact collision at ${objectKey}`);
      }
    }
    return `s3://${this.bucket}/${objectKey}`;
  }
}

export function artifactStoreFromEnv(): ImmutableArtifactStore {
  const bucket = process.env.S3_BUCKET?.trim();
  if (bucket) return new S3ArtifactStore({ bucket, prefix: process.env.S3_PREFIX ?? "rules/" });
  const localRoot = process.env.FARLANDS_ARTIFACT_DIR?.trim();
  if (localRoot) return new LocalArtifactStore(localRoot);
  throw new Error(
    "Rule artifact storage is unavailable; configure S3_BUCKET or FARLANDS_ARTIFACT_DIR",
  );
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const url = new URL(uri);
  const bucket = url.hostname;
  const key = url.pathname.replace(/^\/+/, "");
  if (!bucket || !key) throw new Error("Invalid S3 artifact URI");
  return { bucket, key };
}

/** Read immutable bytes for deployment-time verification. */
export async function readArtifactBytes(uri: string): Promise<Uint8Array> {
  if (uri.startsWith("file://")) return readFile(fileURLToPath(uri));
  if (uri.startsWith("s3://")) {
    const { bucket, key } = parseS3Uri(uri);
    const response = await new S3Client({}).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return bodyBytes(response.Body);
  }
  throw new Error(`Unsupported immutable artifact URI scheme: ${uri}`);
}

export async function verifyArtifactBytes(uri: string, expectedDigest: string): Promise<number> {
  const bytes = await readArtifactBytes(uri);
  const received = sha256Digest(bytes);
  if (received !== expectedDigest) {
    throw new Error(
      `Stored rule artifact digest mismatch: expected ${expectedDigest}, received ${received}`,
    );
  }
  return bytes.byteLength;
}
