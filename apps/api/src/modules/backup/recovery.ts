import type { BackupOperation } from "./attempt";
import { type BackupObjectMetadata, getBackupObjectMetadata } from "./s3";

export type BackupObjectMetadataLookup = (
  storagePath: string,
) => Promise<BackupObjectMetadata | null>;

export async function lookupMissingCreateBackupObject(
  operation: BackupOperation,
  storagePath: string,
  lookup: BackupObjectMetadataLookup = getBackupObjectMetadata,
): Promise<BackupObjectMetadata | null> {
  if (operation !== "create" || !storagePath.trim()) return null;
  return lookup(storagePath);
}
