import { describe, expect, test } from "bun:test";
import type * as k8s from "@kubernetes/client-node";

import {
  BACKUP_ATTEMPT_ANNOTATION,
  BACKUP_ATTEMPT_LABEL,
  backupJobLookupNamespaces,
  backupJobMatchesOperationAttempt,
  backupOperationJobName,
  backupSidecarEndpoint,
  buildBackupDeleteJob,
  buildBackupRestoreJob,
  kubernetesCreateErrorIsAmbiguous,
  resolveImmutableBackupImage,
  selectBackupJobForAttempt,
  serverPodsAreQuiesced,
} from "../src/modules/backup/k8s-job";

const storageConfig = {
  bucket: "backup-bucket",
  region: "ap-south-1",
  prefix: "infra-team",
};

describe("backup restore Kubernetes job", () => {
  test("targets the service recorded for the currently promoted workload", () => {
    expect(backupSidecarEndpoint("svc-cand-server-deploy")).toBe(
      "http://svc-cand-server-deploy:8080/backup",
    );
    expect(() => backupSidecarEndpoint("bad/service")).toThrow("DNS label");
  });

  test("requires immutable worker images for manual operations", () => {
    const pinned = `alpine@sha256:${"a".repeat(64)}`;
    expect(resolveImmutableBackupImage("BACKUP_IMAGE_ARCHIVE", pinned, "unused")).toBe(pinned);
    expect(() =>
      resolveImmutableBackupImage("BACKUP_IMAGE_ARCHIVE", "alpine:latest", pinned),
    ).toThrow("must be pinned by sha256 digest");
  });

  test("keeps the operation Lease for ambiguous Job create outcomes", () => {
    expect(kubernetesCreateErrorIsAmbiguous(new Error("connection reset"))).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ code: "ECONNRESET" })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ code: 408 })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 500 })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ response: { statusCode: 429 } })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 400 })).toBe(false);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 409 })).toBe(false);
  });

  test("requires every game pod to be terminal before mounting a restore", () => {
    expect(serverPodsAreQuiesced([])).toBe(true);
    expect(serverPodsAreQuiesced([{ status: { phase: "Succeeded" } }] as never)).toBe(true);
    expect(serverPodsAreQuiesced([{ status: { phase: "Pending" } }] as never)).toBe(false);
    expect(serverPodsAreQuiesced([{ status: { phase: "Unknown" } }] as never)).toBe(false);
  });

  test("downloads the archive before replacing the stopped server PVC", async () => {
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const job = buildBackupRestoreJob(
      backupOperationJobName("restore", attemptId),
      "backup-id",
      "server-id",
      "fl-user-id",
      attemptId,
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );

    const podSpec = job.spec?.template.spec!;

    expect(job.metadata?.labels?.["farlands.dev/backup-operation"]).toBe("restore");
    expect(job.metadata?.labels?.[BACKUP_ATTEMPT_LABEL]).toBe(attemptId);
    expect(job.metadata?.annotations?.[BACKUP_ATTEMPT_ANNOTATION]).toBe(attemptId);
    expect(job.metadata?.name).toContain(attemptId);
    expect(job.metadata?.namespace).toBe("fl-user-id");
    expect(podSpec.initContainers?.[0]?.name).toBe("download-backup");
    expect(podSpec.initContainers?.[1]?.name).toBe("validate-backup");
    expect(podSpec.initContainers?.[1]?.command?.[2]).toContain("tar -tzf /backup/restore.tar.gz");
    expect(podSpec.initContainers?.[1]?.volumeMounts?.[0]?.readOnly).toBe(true);
    expect(podSpec.containers[0]?.name).toBe("restore-backup");
    expect(podSpec.volumes?.[0]?.persistentVolumeClaim?.claimName).toBe("pvc-server-id");
    expect(podSpec.affinity).toBeUndefined();

    const restoreCommand = podSpec.containers[0]?.command?.[2];
    expect(restoreCommand).toContain(".farlands-restore-staging");
    expect(restoreCommand).toContain(".farlands-restore-rollback");
    expect(restoreCommand).toContain('tar -xzf /backup/restore.tar.gz -C "$STAGE"');
    expect(restoreCommand).toContain("trap rollback EXIT");
    expect(restoreCommand).toContain("recovery data remains at $ROLLBACK");
    expect(restoreCommand).toContain("Restore blocked: manual recovery data exists");
    expect(restoreCommand).not.toContain("find /world -mindepth 1 -maxdepth 1 -exec rm");
    expect(job.spec?.ttlSecondsAfterFinished).toBe(7 * 24 * 60 * 60);
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.containers[0]?.securityContext?.readOnlyRootFilesystem).toBe(true);

    const syntaxCheck = Bun.spawn(["sh", "-n"], {
      stdin: new Blob([restoreCommand ?? ""]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(syntaxCheck.stderr).text()).toBe("");
    expect(await syntaxCheck.exited).toBe(0);

    const storagePath = podSpec.initContainers?.[0]?.env?.find(
      (entry: { name: string }) => entry.name === "STORAGE_PATH",
    );
    expect(storagePath?.value).toBe("infra-team/server-id/archive.tar.gz");
  });

  test("keeps a stale reconciler scoped to its own restore attempt", () => {
    const attemptA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const attemptB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const jobA = buildBackupRestoreJob(
      backupOperationJobName("restore", attemptA),
      "backup-id",
      "server-id",
      "fl-user-id",
      attemptA,
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    jobA.metadata!.creationTimestamp = new Date("2026-08-30T03:00:00Z");
    jobA.status = { conditions: [{ type: "Complete", status: "True" }] };

    const jobB = buildBackupRestoreJob(
      backupOperationJobName("restore", attemptB),
      "backup-id",
      "server-id",
      "fl-user-id",
      attemptB,
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    jobB.metadata!.creationTimestamp = new Date("2026-08-30T03:01:00Z");

    expect(
      backupJobMatchesOperationAttempt(
        jobB,
        "server-id",
        "backup-id",
        "restore",
        attemptA,
        new Date("2026-08-30T03:00:00Z"),
      ),
    ).toBe(false);
    expect(
      selectBackupJobForAttempt(
        [jobA, jobB] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "restore",
        attemptA,
        new Date("2026-08-30T03:00:00Z"),
      )?.metadata?.name,
    ).toBe(jobA.metadata?.name);
    expect(
      selectBackupJobForAttempt(
        [jobA, jobB] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "restore",
        attemptB,
        new Date("2026-08-30T03:01:00Z"),
      )?.metadata?.name,
    ).toBe(jobB.metadata?.name);
  });

  test("does not adopt a retained unlabeled Job for a migrated attempt", () => {
    const attemptId = "legacy-migrated-attempt";
    const claimStartedAt = new Date("2026-08-30T03:01:00Z");
    const oldJob = buildBackupRestoreJob(
      "backup-restore-old",
      "backup-id",
      "server-id",
      "fl-user-id",
      "old-attempt",
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    delete oldJob.metadata?.labels?.[BACKUP_ATTEMPT_LABEL];
    delete oldJob.metadata?.annotations?.[BACKUP_ATTEMPT_ANNOTATION];
    oldJob.metadata!.creationTimestamp = new Date("2026-08-30T02:55:00Z");
    oldJob.status = { conditions: [{ type: "Complete", status: "True" }] };

    const currentJob = buildBackupRestoreJob(
      "backup-restore-current",
      "backup-id",
      "server-id",
      "fl-user-id",
      "current-attempt",
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    delete currentJob.metadata?.labels?.[BACKUP_ATTEMPT_LABEL];
    delete currentJob.metadata?.annotations?.[BACKUP_ATTEMPT_ANNOTATION];
    currentJob.metadata!.creationTimestamp = new Date("2026-08-30T03:01:02Z");

    expect(
      backupJobMatchesOperationAttempt(
        oldJob,
        "server-id",
        "backup-id",
        "restore",
        attemptId,
        claimStartedAt,
      ),
    ).toBe(false);
    expect(
      selectBackupJobForAttempt(
        [oldJob, currentJob] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "restore",
        attemptId,
        claimStartedAt,
      )?.metadata?.name,
    ).toBe(currentJob.metadata?.name);
  });

  test("looks up legacy Jobs in the origin namespace without widening new attempts", () => {
    expect(backupJobLookupNamespaces("fl-user-id", "legacy-migrated-attempt")).toEqual([
      "fl-user-id",
      "infra-team",
    ]);
    expect(backupJobLookupNamespaces("fl-user-id", "new-attempt-id")).toEqual(["fl-user-id"]);
  });
});

describe("backup delete Kubernetes job", () => {
  test("passes the storage key through an environment variable", () => {
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const job = buildBackupDeleteJob(
      backupOperationJobName("delete", attemptId),
      "backup-id",
      "server-id",
      "fl-user-id",
      attemptId,
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    const container = job.spec?.template.spec?.containers[0];

    expect(job.metadata?.namespace).toBe("fl-user-id");
    expect(job.metadata?.labels?.[BACKUP_ATTEMPT_LABEL]).toBe(attemptId);
    expect(container?.command?.[2]).toContain("${STORAGE_PATH}");
    expect(container?.command?.[2]).not.toContain("infra-team/server-id/archive.tar.gz");
    expect(container?.env?.find((entry) => entry.name === "STORAGE_PATH")?.value).toBe(
      "infra-team/server-id/archive.tar.gz",
    );
  });

  test("recovers the newest migrated delete Job created before rollout", () => {
    const claimStartedAt = new Date("2026-08-30T04:00:00Z");
    const oldJob = buildBackupDeleteJob(
      "delete-backup-id-20260830-020000",
      "backup-id",
      "server-id",
      "infra-team",
      "old-attempt",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    const currentJob = buildBackupDeleteJob(
      "delete-backup-id-20260830-035500",
      "backup-id",
      "server-id",
      "infra-team",
      "current-attempt",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    for (const [job, createdAt] of [
      [oldJob, new Date("2026-08-30T02:00:00Z")],
      [currentJob, new Date("2026-08-30T03:55:00Z")],
    ] as const) {
      delete job.metadata?.labels?.[BACKUP_ATTEMPT_LABEL];
      delete job.metadata?.annotations?.[BACKUP_ATTEMPT_ANNOTATION];
      job.metadata!.creationTimestamp = createdAt;
    }
    currentJob.status = { conditions: [{ type: "Complete", status: "True" }] };

    expect(
      selectBackupJobForAttempt(
        [oldJob, currentJob] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "delete",
        "legacy-migrated-attempt",
        claimStartedAt,
      )?.metadata?.name,
    ).toBe(currentJob.metadata?.name);
  });

  test("does not adopt a retained failed delete Job for a runtime-adopted retry", () => {
    const priorFailureAt = new Date("2026-08-30T03:00:00Z");
    const attemptId = "legacy-runtime-1788066000000-00000000-0000-4000-8000-000000000000";
    const retainedFailedJob = buildBackupDeleteJob(
      "delete-backup-id-prior-failure",
      "backup-id",
      "server-id",
      "infra-team",
      "old-attempt",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    const currentRetryJob = buildBackupDeleteJob(
      "delete-backup-id-current-retry",
      "backup-id",
      "server-id",
      "infra-team",
      "current-attempt",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    for (const [job, createdAt] of [
      [retainedFailedJob, new Date("2026-08-30T02:50:00Z")],
      [currentRetryJob, new Date("2026-08-30T03:00:02Z")],
    ] as const) {
      delete job.metadata?.labels?.[BACKUP_ATTEMPT_LABEL];
      delete job.metadata?.annotations?.[BACKUP_ATTEMPT_ANNOTATION];
      job.metadata!.creationTimestamp = createdAt;
    }
    retainedFailedJob.status = { conditions: [{ type: "Failed", status: "True" }] };

    expect(
      selectBackupJobForAttempt(
        [retainedFailedJob] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "delete",
        attemptId,
        priorFailureAt,
      ),
    ).toBeUndefined();
    expect(
      selectBackupJobForAttempt(
        [retainedFailedJob, currentRetryJob] as k8s.V1Job[],
        "server-id",
        "backup-id",
        "delete",
        attemptId,
        priorFailureAt,
      )?.metadata?.name,
    ).toBe(currentRetryJob.metadata?.name);
  });
});
