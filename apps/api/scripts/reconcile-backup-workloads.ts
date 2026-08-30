import {
  assertLegacyBackupReconciliationReady,
  listLegacyMinecraftBackupRealms,
  reconcileLegacyMinecraftBackup,
} from "../src/modules/backup/reconcile";

const dryRun = process.argv.includes("--dry-run");
const serverArgument = process.argv.find((argument) => argument.startsWith("--server="));
const selectedServerId = serverArgument?.slice("--server=".length);

const discovered = await listLegacyMinecraftBackupRealms();
const realms = selectedServerId
  ? discovered.filter((realm) => realm.serverId === selectedServerId)
  : discovered;

if (selectedServerId && realms.length === 0) {
  console.error(`No active Minecraft realm found for --server=${selectedServerId}`);
  process.exit(1);
}

console.log(
  `${dryRun ? "Would reconcile" : "Reconciling"} ${realms.length} active Minecraft backup workload(s)`,
);

if (dryRun) {
  let blocked = 0;
  for (const realm of realms) {
    try {
      await assertLegacyBackupReconciliationReady(realm);
      console.log(
        `- ${realm.serverId}: ready; ${realm.namespace}/${realm.deploymentName}, PVC ${realm.pvcName}`,
      );
    } catch (error) {
      blocked += 1;
      console.error(
        `- ${realm.serverId}: blocked:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (blocked > 0) {
    console.error(
      `Backup workload dry-run found ${blocked}/${realms.length} blocked realm(s); wait for operation reconciliation and retry.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

let failures = 0;
for (const realm of realms) {
  try {
    const result = await reconcileLegacyMinecraftBackup(realm);
    console.log(
      `[${realm.serverId}] ${result.changed ? "reconciled" : "already current"}; desired replicas preserved at ${result.desiredReplicas}`,
    );
  } catch (error) {
    failures += 1;
    console.error(
      `[${realm.serverId}] reconciliation failed:`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
  }
}

if (failures > 0) {
  console.error(`Backup workload reconciliation failed for ${failures}/${realms.length} realm(s)`);
  process.exit(1);
}

console.log("Backup workload reconciliation completed successfully");
process.exit(0);
