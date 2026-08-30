import {
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  paginateListObjectsV2,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveBackupDownloadTtlSeconds, resolveBackupStorageConfig } from "./config";

let cachedClient: { region: string; client: S3Client } | null = null;

function backupS3Client(region: string): S3Client {
  if (cachedClient?.region === region) return cachedClient.client;
  const client = new S3Client({ region });
  cachedClient = { region, client };
  return client;
}

export function listBackups(prefix?: string) {
  const { bucket, region } = resolveBackupStorageConfig();
  return paginateListObjectsV2(
    {
      client: backupS3Client(region),
    },
    {
      Bucket: bucket,
      Prefix: prefix,
    },
  );
}

export function backupDownloadFilename(name: string): string {
  const basename = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/(?:\.tar)?\.gz$/i, "")
    .slice(0, 80);
  return `${basename || "backup"}.tar.gz`;
}

export type BackupObjectMetadata = {
  sizeBytes: number;
  completedAt: Date;
};

export function backupObjectHeadIsMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey"
  );
}

export function backupObjectMetadataFromHead(
  head: Pick<HeadObjectCommandOutput, "ContentLength" | "LastModified">,
): BackupObjectMetadata | null {
  const sizeBytes = Number(head.ContentLength);
  const completedAt = head.LastModified;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
  if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
    return null;
  }
  return { sizeBytes, completedAt };
}

async function headBackupObject(storagePath: string): Promise<HeadObjectCommandOutput | null> {
  const { bucket, region } = resolveBackupStorageConfig();
  try {
    return await backupS3Client(region).send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: storagePath,
      }),
    );
  } catch (error) {
    if (backupObjectHeadIsMissing(error)) return null;
    throw error;
  }
}

export async function backupObjectExists(storagePath: string): Promise<boolean> {
  return (await headBackupObject(storagePath)) !== null;
}

export async function getBackupObjectMetadata(
  storagePath: string,
): Promise<BackupObjectMetadata | null> {
  const head = await headBackupObject(storagePath);
  return head ? backupObjectMetadataFromHead(head) : null;
}

export async function createBackupDownloadUrl(
  storagePath: string,
  backupName: string,
  expiresIn = resolveBackupDownloadTtlSeconds(),
): Promise<{ url: string; expiresAt: Date }> {
  const { bucket, region } = resolveBackupStorageConfig();
  const url = await getSignedUrl(
    backupS3Client(region),
    new GetObjectCommand({
      Bucket: bucket,
      Key: storagePath,
      ResponseContentDisposition: `attachment; filename="${backupDownloadFilename(backupName)}"`,
    }),
    { expiresIn },
  );

  return {
    url,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}
