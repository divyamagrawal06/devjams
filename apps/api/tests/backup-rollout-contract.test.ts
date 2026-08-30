import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type * as k8s from "@kubernetes/client-node";

import { cutoverJobMatchesExpected } from "../src/modules/deploy/cutover";

function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("backup rollout contracts", () => {
  test("publishes one aligned identity and catalog configuration", () => {
    const terraform = readFixture("../backup-arch/backup-worker-irsa.tf");

    for (const key of [
      "FARLANDS_BACKUP_WORKER_ROLE_ARN",
      "FARLANDS_BACKUP_WORKER_SERVICE_ACCOUNT",
      "AWS_REGION",
      "BACKUP_BUCKET",
      "BACKUP_S3_PREFIX",
      "BACKUP_SYNC_ENABLED",
      "BACKUP_SYNC_INTERVAL_MS",
      "BACKUP_NAMESPACE",
      "BACKUP_ORCHESTRATOR_SERVICE_ACCOUNT",
      "BACKUP_CRONJOB_NAME",
      "BACKUP_SCHEDULE_MINUTE_UTC",
      "BACKUP_SCHEDULE_HOUR_UTC",
      "BACKUP_SCHEDULE_DAY_OF_WEEK",
      "BACKUP_RETENTION_COUNT",
    ]) {
      expect(terraform).toContain(key);
    }
    expect(terraform).toContain('BACKUP_SYNC_ENABLED                    = "true"');
  });

  test("does not cap the orchestrator before all bounded worker batches finish", () => {
    const variables = readFixture("../backup-arch/backup-variables.tf");
    expect(variables).toContain('variable "backup_orchestrator_active_deadline_seconds"');
    expect(variables).toContain("default     = null");
    expect(variables).toContain("bounded per-worker waits cover every discovered PVC");
  });

  test("keeps a promoted candidate discoverable by the Terraform PVC selector", () => {
    const variables = readFixture("../backup-arch/backup-variables.tf");
    const cutover = readFixture("../src/modules/deploy/cutover.ts");

    expect(variables).toContain(
      'default     = "app.kubernetes.io/name=farlands-game-server,farlands.dev/backup-strategy=minecraft-rcon"',
    );
    const promotion = cutover.slice(cutover.indexOf("async function promoteCandidateBackupVolume"));
    expect(promotion).toContain('"app.kubernetes.io/name": "farlands-game-server"');
    expect(promotion).toContain('"farlands.dev/backup-strategy": "minecraft-rcon"');
    expect(promotion).toContain('"farlands.dev/backup-server-id": row.serverId');
  });

  test("keeps scheduler workload mutation namespaced to managed tenants", () => {
    const terraform = readFixture("../backup-arch/backup-rbac.tf");

    expect(terraform).toContain('name = "farlands-backup-orchestrator-discovery"');
    expect(terraform).toContain('name = "farlands-backup-tenant-worker"');
    expect(terraform).toContain('resource "kubernetes_role_binding_v1"');
    expect(terraform).toContain("kubernetes_cluster_role_v1.backup_tenant_worker");

    const discoveryRole = terraform.slice(
      terraform.indexOf('resource "kubernetes_cluster_role_v1" "backup_orchestrator_discovery"'),
      terraform.indexOf('resource "kubernetes_cluster_role_v1" "backup_tenant_worker"'),
    );
    expect(discoveryRole).not.toContain('resources  = ["jobs"]');
    expect(discoveryRole).not.toContain('resources  = ["leases"]');
  });

  test("gives each orchestrator process an isolated retry Lease identity", () => {
    const cronJob = readFixture("../backup-arch/backup-cronjob.tf");
    const rbac = readFixture("../backup-arch/backup-rbac.tf");
    const tenantRole = rbac.slice(
      rbac.indexOf('resource "kubernetes_cluster_role_v1" "backup_tenant_worker"'),
      rbac.indexOf('resource "kubernetes_cluster_role_binding_v1"'),
    );

    expect(cronJob).toContain('name = "BACKUP_ORCHESTRATOR_INVOCATION_ID"');
    expect(cronJob).toContain('field_path = "metadata.uid"');
    expect(tenantRole).toContain('resources  = ["jobs"]');
    expect(tenantRole).toContain('"delete"');
  });

  test("recovers every legacy active backup operation during migration", () => {
    const operationMigration = readFixture(
      "../../../packages/db/migrations/0013_backup_console_weekly.sql",
    );
    const startedAtMigration = readFixture(
      "../../../packages/db/migrations/0014_backup_operation_started_at.sql",
    );
    const attemptMigration = readFixture(
      "../../../packages/db/migrations/0015_backup_operation_attempt_id.sql",
    );

    expect(operationMigration).toContain("\"backup\".\"status\" IN ('pending', 'in_progress')");
    expect(operationMigration).toContain("'restore_started' THEN 'restore'");
    expect(operationMigration).toContain("ELSE 'delete'");
    expect(startedAtMigration).toContain('"backup"."active_operation" = \'restore\'');
    expect(startedAtMigration).toContain("NOW()");
    expect(attemptMigration).toContain('"active_operation_attempt_id"');
    expect(attemptMigration).toContain("'legacy-' || md5");
    expect(attemptMigration).toContain('"active_operation" IS NOT NULL');
    expect(attemptMigration).toContain('"backup"."active_operation" = \'delete\'');
    expect(attemptMigration).toContain("'backup_completed', 'backup_failed'");
  });

  test("adopts operations written by an old API after migration before startup", () => {
    const backupService = readFixture("../src/modules/backup/service.ts");
    const apiEntry = readFixture("../src/index.ts");
    const adoption = backupService.slice(
      backupService.indexOf("async function adoptLegacyBackupOperation("),
      backupService.indexOf("export abstract class BackupService"),
    );

    expect(adoption).toContain('.for("update")');
    expect(adoption).toContain("inferLegacyBackupOperation(");
    expect(adoption).toContain("runtimeLegacyBackupAttemptId(");
    expect(adoption).toContain("legacyBackupOperationAdoptionClaim(adoptionStatus)");
    expect(adoption.indexOf('.for("update")')).toBeLessThan(
      adoption.indexOf("inferLegacyBackupOperation("),
    );
    expect(adoption.indexOf("inferLegacyBackupOperation(")).toBeLessThan(
      adoption.indexOf(".update(backups)"),
    );

    const monitor = backupService.slice(
      backupService.indexOf("private static async monitorBackupOperation("),
      backupService.indexOf("private static startBackupOperationMonitor("),
    );
    expect(monitor).toContain("await this.reconcileBackupOperation(backup)");
    expect(monitor).not.toContain("if (!backup?.activeOperation)");

    const startupAdoption = apiEntry.indexOf("await BackupService.resumeOperationMonitors()");
    const deploymentReconciliation = apiEntry.indexOf("await reconcileInFlight()");
    const listen = apiEntry.indexOf("app.listen(");
    expect(startupAdoption).toBeGreaterThanOrEqual(0);
    expect(deploymentReconciliation).toBeGreaterThan(startupAdoption);
    expect(listen).toBeGreaterThan(deploymentReconciliation);
  });

  test("quiesces old controllers and guards legacy unleased operations", () => {
    const rollout = readFixture("../backup-arch/README.md");
    const guard = readFixture("../src/modules/deploy/guard.ts");
    const serverService = readFixture("../src/modules/servers/service.ts");
    const cutover = readFixture("../src/modules/deploy/cutover.ts");

    expect(rollout).toContain("patch cronjob server-backup-orchestrator");
    expect(rollout).toContain("--type=merge --patch");
    expect(rollout).toContain("Keep this CronJob suspended through");
    expect(rollout).toContain("terminal `Complete=True` or `Failed=True` condition");
    expect(rollout).toContain("`status.active=0` is not terminal");
    expect(rollout).toContain("delete that exact Job with `--wait=true`");
    expect(rollout).toContain("scale the existing backend/controller\n   Deployment to zero");
    expect(rollout).toContain("not a rolling\n   overlap between old and new controllers");
    expect(rollout).toContain("absent from the readback before continuing");
    expect(guard).toContain("isNotNull(backups.activeOperation)");
    expect(guard).toContain('inArray(backups.status, ["pending", "in_progress"])');

    const serverGuard = serverService.indexOf("await assertNoActiveServerBackup(serverId)");
    const serverMutation = serverService.indexOf("return await run(assertLeaseHeld)", serverGuard);
    expect(serverGuard).toBeGreaterThanOrEqual(0);
    expect(serverMutation).toBeGreaterThan(serverGuard);

    const cutoverRenewal = cutover.indexOf("await renewOnce();");
    const cutoverGuard = cutover.indexOf(
      "await assertNoActiveServerBackup(row.serverId)",
      cutoverRenewal,
    );
    expect(cutoverGuard).toBeGreaterThan(cutoverRenewal);
  });

  test("keeps failed restore recovery durable across lifecycle races", () => {
    const backupService = readFixture("../src/modules/backup/service.ts");
    const serverService = readFixture("../src/modules/servers/service.ts");

    expect(backupService).toContain('backupOperationAttemptClaim("restore", restoreAttemptId)');
    expect(backupService).toContain('eq(gameServers.statusMessage, "Restoring backup")');
    expect(backupService).toContain(
      'currentState: restoreNeedsManualRecovery ? "failed" : "stopped"',
    );
    expect(backupService).toContain("const restoreNeedsManualRecovery = restoreFailed");
    expect(backupService).toContain(
      "statusMessage: retryingRecovery\n            ? BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE",
    );
    const restoreClaim = backupService.slice(
      backupService.indexOf("const retryingRecovery ="),
      backupService.indexOf("const [backup] =", backupService.indexOf("const retryingRecovery =")),
    );
    expect(restoreClaim).toContain("backupRestoreRecoveryRequired(server?.statusMessage)");
    expect(restoreClaim).not.toContain('server?.currentState === "failed"');
    expect(backupService).toContain(
      "definitelyNotStarted && !restoreBackup.retryingRecovery\n                ? null\n                : BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE",
    );
    expect(serverService).toContain("backupRestoreRecoveryRequired(previousState.statusMessage)");
  });

  test("atomically fences a missing Job before finalizing its durable claim", () => {
    const backupService = readFixture("../src/modules/backup/service.ts");
    const backupJob = readFixture("../src/modules/backup/k8s-job.ts");

    expect(backupService).toContain("backupReconciliationLeaseHolder");
    expect(backupService).toContain("BACKUP_RECONCILIATION_LEASE_SECONDS");
    expect(backupService).toContain("await releaseMissingJobFence();\n    return updatedBackup;");
    expect(backupJob).toContain("renewJobLeaseWithRequiredValidity");
    expect(backupJob).toContain("JOB_LEASE_TERMINATION_MARGIN_SECONDS");
  });

  test("fences a late dispatcher before restore preparation and Job creation", () => {
    const backupJob = readFixture("../src/modules/backup/k8s-job.ts");
    const backupService = readFixture("../src/modules/backup/service.ts");
    const createLockedJob = backupJob.slice(
      backupJob.indexOf("async function createLockedJob("),
      backupJob.indexOf("export async function releaseBackupOperationLease("),
    );
    const initialAcquire = createLockedJob.indexOf("await acquireBackupLease(");
    const firstDurableCheck = createLockedJob.indexOf(
      "if (!(await durableAttemptIsActive())) return;",
      initialAcquire,
    );
    const mutatingPreparation = createLockedJob.indexOf('typeof jobSpec === "function"');
    const finalRenewal = createLockedJob.indexOf("await renewJobLeaseWithRequiredValidity(");
    const finalDurableCheck = createLockedJob.indexOf(
      "if (!(await durableAttemptIsActive())) return;",
      firstDurableCheck + 1,
    );
    const jobCreate = createLockedJob.indexOf("await batch.createNamespacedJob(");
    const finalDeadlineFence = createLockedJob.lastIndexOf(
      "assertBackupLeaseRemaining(confirmedUntil, JOB_REQUIRED_LEASE_REMAINING_MS)",
      jobCreate,
    );
    const quiesceRestore = backupJob.slice(
      backupJob.indexOf("async function quiesceServerForRestore("),
      backupJob.indexOf(
        "// ── helpers",
        backupJob.indexOf("async function quiesceServerForRestore("),
      ),
    );
    const deploymentFence = quiesceRestore.indexOf("assertLeaseHeld();");
    const deploymentPatch = quiesceRestore.indexOf("patchNamespacedDeployment(");

    expect(initialAcquire).toBeGreaterThanOrEqual(0);
    expect(firstDurableCheck).toBeGreaterThan(initialAcquire);
    expect(mutatingPreparation).toBeGreaterThan(firstDurableCheck);
    expect(finalRenewal).toBeGreaterThan(mutatingPreparation);
    expect(finalDurableCheck).toBeGreaterThan(finalRenewal);
    expect(finalDeadlineFence).toBeGreaterThan(finalDurableCheck);
    expect(jobCreate).toBeGreaterThan(finalDurableCheck);
    expect(jobCreate).toBeGreaterThan(finalDeadlineFence);
    expect(deploymentFence).toBeGreaterThanOrEqual(0);
    expect(deploymentPatch).toBeGreaterThan(deploymentFence);
    expect(backupService).toContain("backupOperationAttemptClaim(operation, attemptId)");
    expect(backupService).toContain(
      'durableBackupAttemptIsActive(restoreBackup.id, "restore", restoreAttemptId)',
    );
  });

  test("renews for the full cutover Job and validates deterministic reuse", () => {
    const cutover = readFixture("../src/modules/deploy/cutover.ts");
    const deployController = readFixture("../src/modules/deploy/controller.ts");
    const runJob = cutover.slice(
      cutover.indexOf("async function runJob("),
      cutover.indexOf("export async function freezeAndSyncDelta("),
    );
    const renewal = runJob.indexOf("await assertLeaseHeld(requiredRemainingMs)");
    const deadlineFence = runJob.indexOf(
      "assertBackupLeaseRemaining(confirmedUntil, requiredRemainingMs)",
    );
    const create = runJob.indexOf("await batch.createNamespacedJob(");
    const readExisting = runJob.indexOf("await batch.readNamespacedJob(", create);
    const validateExisting = runJob.indexOf("cutoverJobMatchesExpected(existing, desiredJob)");

    expect(renewal).toBeGreaterThanOrEqual(0);
    expect(deadlineFence).toBeGreaterThan(renewal);
    expect(create).toBeGreaterThan(deadlineFence);
    expect(readExisting).toBeGreaterThan(create);
    expect(validateExisting).toBeGreaterThan(readExisting);
    expect(cutover).toContain("error instanceof CutoverJobStateUncertainError");
    expect(cutover).toContain("if (retainLease)");
    expect(deployController).toContain("error instanceof CutoverJobStateUncertainError");
    expect(deployController).toContain("scheduleReconcileAt(error.retryAt.getTime())");
    expect(deployController).toContain("compensation deferred until its server Lease expires");

    const expected = {
      metadata: {
        name: "job-freeze-deployment",
        namespace: "fl-user",
        labels: {
          "app.kubernetes.io/managed-by": "farlands-backend",
          "farlands.dev/deployment-id": "deployment",
          "farlands.dev/component": "cutover",
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 1_200,
        ttlSecondsAfterFinished: 3_600,
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/managed-by": "farlands-backend",
              "farlands.dev/deployment-id": "deployment",
              "farlands.dev/component": "cutover",
            },
          },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            containers: [
              {
                name: "freeze-delta",
                image: `world-sync@sha256:${"a".repeat(64)}`,
                command: ["python3", "/cutover/freeze_delta.py"],
              },
            ],
          },
        },
      },
    } as k8s.V1Job;
    const apiReadback = structuredClone(expected);
    apiReadback.metadata!.labels!["batch.kubernetes.io/controller-uid"] = "controller";
    apiReadback.spec!.template.spec!.serviceAccountName = "default";
    expect(cutoverJobMatchesExpected(apiReadback, expected)).toBe(true);

    const conflicting = structuredClone(apiReadback);
    conflicting.spec!.template.spec!.containers[0]!.image = `unreviewed@sha256:${"b".repeat(64)}`;
    expect(cutoverJobMatchesExpected(conflicting, expected)).toBe(false);
  });

  test("binds terminal reconciliation and storage sync to one durable attempt", () => {
    const backupService = readFixture("../src/modules/backup/service.ts");
    const backupSync = readFixture("../src/modules/backup/sync.ts");
    const backupJob = readFixture("../src/modules/backup/k8s-job.ts");

    expect(backupService).toContain("backupOperationAttemptClaim(operation, attemptId)");
    expect(backupService).toContain("releaseBackupOperationLease(");
    expect(backupSync).toContain('backupOperationAttemptClaim("create"');
    expect(backupJob).toContain("BACKUP_ATTEMPT_LABEL");
    expect(backupJob).toContain("selectBackupJobForAttempt");
  });
});
