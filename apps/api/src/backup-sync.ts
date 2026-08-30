import "./load-env";
import { resolveBackupSyncConfig } from "./modules/backup/config";
import { syncBackupsFromS3 } from "./modules/backup/sync";

type BackupSyncLoopOptions = {
  environment?: Record<string, string | undefined>;
  sync?: () => Promise<void>;
};

export function startBackupSyncLoop({
  environment = process.env,
  sync = syncBackupsFromS3,
}: BackupSyncLoopOptions = {}): (() => void) | null {
  const { enabled, intervalMs } = resolveBackupSyncConfig(environment);
  if (!enabled) return null;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await sync();
    } catch (error) {
      console.error("[backup-sync] Catalog reconciliation failed:", error);
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };

  console.info(`[backup-sync] Catalog reconciliation enabled (every ${intervalMs}ms)`);
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

if (import.meta.main) startBackupSyncLoop();
