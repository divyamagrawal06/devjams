import { describe, expect, test } from "bun:test";
import type * as k8s from "@kubernetes/client-node";
import {
  type BackupConfig,
  backupLeaseExpired,
  backupLeaseName,
  buildBackupJob,
  classifyServerWorkload,
  createOrReuseWeeklyJob,
  kubernetesCreateErrorIsAmbiguous,
  loadConfig,
  mapWithConcurrency,
  releaseWeeklyBackupLease,
  resolveLeasedBackupTarget,
  resolveWeeklyInvocationId,
  retryWeeklyLeaseRelease,
  targetFromPvc,
  workerIdentityMatches,
  weeklyJobMatchesRun,
  weeklyJobTerminalState,
  weeklyLeaseHolder,
  weeklyLeaseReflectsMutation,
  weeklyRunId,
} from "./index";

const config: BackupConfig = {
  labelSelector: "app.kubernetes.io/name=farlands-game-server",
  bucket: "backup-bucket",
  region: "ap-south-1",
  prefix: "farlands-live",
  archiveImage: "alpine:3.20",
  uploadImage: "amazon/aws-cli:2.15.0",
  workerServiceAccount: "backup-orchestrator",
  workerRoleArn: "arn:aws:iam::123456789012:role/farlands-backup-worker-irsa",
  retentionCount: 3,
  maxConcurrency: 2,
  workerActiveDeadlineSeconds: 7_200,
  workerPollIntervalMs: 10_000,
  tempSizeLimit: "25Gi",
};

describe("weekly backup configuration", () => {
  test("loads and normalizes the configured values", () => {
    expect(
      loadConfig({
        PVC_LABEL_SELECTOR: config.labelSelector,
        S3_BUCKET: config.bucket,
        S3_REGION: config.region,
        S3_PREFIX: "/farlands-live/",
        BACKUP_IMAGE_ARCHIVE: config.archiveImage,
        BACKUP_IMAGE_UPLOAD: config.uploadImage,
        BACKUP_WORKER_SERVICE_ACCOUNT: config.workerServiceAccount,
        BACKUP_WORKER_ROLE_ARN: config.workerRoleArn,
        BACKUP_RETENTION_COUNT: "4",
        BACKUP_MAX_CONCURRENCY: "2",
      }),
    ).toMatchObject({
      prefix: "farlands-live",
      retentionCount: 4,
      maxConcurrency: 2,
      workerActiveDeadlineSeconds: 7_200,
    });
  });

  test("rejects unsafe prefixes and invalid retention", () => {
    const base = {
      PVC_LABEL_SELECTOR: config.labelSelector,
      S3_BUCKET: config.bucket,
      S3_REGION: config.region,
      BACKUP_IMAGE_ARCHIVE: config.archiveImage,
      BACKUP_IMAGE_UPLOAD: config.uploadImage,
      BACKUP_WORKER_SERVICE_ACCOUNT: config.workerServiceAccount,
      BACKUP_WORKER_ROLE_ARN: config.workerRoleArn,
    };

    expect(() => loadConfig({ ...base, S3_PREFIX: "../other" })).toThrow("S3_PREFIX");
    expect(() =>
      loadConfig({ ...base, S3_PREFIX: "farlands-live", BACKUP_RETENTION_COUNT: "0" }),
    ).toThrow("BACKUP_RETENTION_COUNT");
  });
});

describe("weekly run identity", () => {
  test("uses ISO weeks across a calendar-year boundary", () => {
    expect(weeklyRunId(new Date("2020-12-31T23:00:00Z"))).toBe("2020-w53");
    expect(weeklyRunId(new Date("2021-01-01T01:00:00Z"))).toBe("2020-w53");
    expect(weeklyRunId(new Date("2021-01-04T03:00:00Z"))).toBe("2021-w01");
  });

  test("uses a unique Lease holder for each orchestrator invocation", () => {
    expect(weeklyLeaseHolder("2026-w35", "pod-a")).toBe("weekly:2026-w35:pod-a");
    expect(weeklyLeaseHolder("2026-w35", "pod-a")).not.toBe(
      weeklyLeaseHolder("2026-w35", "pod-b"),
    );
    expect(
      resolveWeeklyInvocationId({ BACKUP_ORCHESTRATOR_INVOCATION_ID: "pod-c" }),
    ).toBe("pod-c");
    expect(() => weeklyLeaseHolder("2026-w35", "not/a/uid")).toThrow(
      "BACKUP_ORCHESTRATOR_INVOCATION_ID",
    );
  });
});

describe("weekly worker Job", () => {
  test("raw-mounts only a confirmed zero-replica workload", () => {
    const stoppedDeployment = { spec: { replicas: 0 } } as k8s.V1Deployment;
    expect(classifyServerWorkload([stoppedDeployment], [])).toEqual({ mode: "stopped" });

    const pendingPod = {
      spec: {},
      status: { phase: "Pending" },
    } as k8s.V1Pod;
    expect(classifyServerWorkload([stoppedDeployment], [pendingPod]).mode).toBe("unsafe");
    expect(
      classifyServerWorkload([{ spec: { replicas: 1 } } as k8s.V1Deployment], []).mode,
    ).toBe("unsafe");
  });

  test("uses the sidecar only for one ready, scheduled running pod", () => {
    const deployment = { spec: { replicas: 1 } } as k8s.V1Deployment;
    const runningPod = {
      spec: { nodeName: "worker-node-a" },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      },
    } as k8s.V1Pod;

    expect(classifyServerWorkload([deployment], [runningPod])).toEqual({
      mode: "running",
      nodeName: "worker-node-a",
    });
    expect(
      classifyServerWorkload([deployment], [
        runningPod,
        { status: { phase: "Pending" } } as k8s.V1Pod,
      ]).mode,
    ).toBe("unsafe");
  });

  test("accepts only the configured IRSA worker identity", () => {
    const identity = {
      metadata: {
        annotations: { "eks.amazonaws.com/role-arn": config.workerRoleArn },
      },
      automountServiceAccountToken: false,
    } as k8s.V1ServiceAccount;

    expect(workerIdentityMatches(identity, config.workerRoleArn)).toBe(true);
    expect(workerIdentityMatches(identity, "arn:aws:iam::123456789012:role/other")).toBe(false);
    expect(workerIdentityMatches({ ...identity, automountServiceAccountToken: true }, config.workerRoleArn)).toBe(false);
  });

  test("uses the PVC namespace and a verified, encrypted weekly S3 path", () => {
    const job = buildBackupJob(
      {
        namespace: "fl-user",
        pvcName: "pvc-server-id",
        serverId: "server-id",
        nodeName: "worker-node-a",
      },
      config,
      "2026-w35",
    );

    expect(job.metadata?.namespace).toBe("fl-user");
    expect(job.metadata?.annotations?.["farlands.dev/backup-storage-key"]).toBe(
      "farlands-live/server-id/weekly/server-id-weekly-2026-w35.tar.gz",
    );

    const pod = job.spec?.template.spec!;
    expect(pod.serviceAccountName).toBe("backup-orchestrator");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.nodeSelector?.["kubernetes.io/hostname"]).toBe("worker-node-a");
    expect(job.spec?.activeDeadlineSeconds).toBe(7_200);

    const archiveCommand = pod.initContainers?.[0]?.command?.[2] ?? "";
    expect(archiveCommand).toContain("tar -tzf");
    expect(archiveCommand).toContain("BACKUP_ENDPOINT");
    expect(archiveCommand).toContain("server\\.properties");
    expect(
      pod.initContainers?.[0]?.env?.find((entry) => entry.name === "BACKUP_ENDPOINT")?.value,
    ).toBe("http://svc-server-server-id:8080/backup");

    const upload = pod.containers[0];
    const uploadCommand = upload.command?.[2] ?? "";
    expect(uploadCommand).toContain("--sse AES256");
    expect(uploadCommand).toContain("--checksum-algorithm SHA256");
    expect(uploadCommand).toContain("--checksum-mode ENABLED");
    expect(uploadCommand).toContain("list-objects-v2");
    expect(upload.env?.find((entry) => entry.name === "BACKUP_RETENTION_COUNT")?.value).toBe("3");
    expect(upload.securityContext?.readOnlyRootFilesystem).toBe(true);

    const stoppedJob = buildBackupJob(
      {
        namespace: "fl-user",
        pvcName: "pvc-server-id",
        serverId: "server-id",
      },
      config,
      "2026-w35",
    );
    expect(stoppedJob.spec?.template.spec?.initContainers?.[0]?.command?.[2]).toContain(
      "Manual restore recovery data must be resolved before backup",
    );
  });

  test("requires namespace, name, and server-id metadata", () => {
    const pvc = {
      metadata: { name: "pvc-without-server-label", namespace: "fl-user", labels: {} },
    } as k8s.V1PersistentVolumeClaim;
    expect(() => targetFromPvc(pvc)).toThrow("farlands.dev/server-id");

    const legacyPvc = {
      metadata: {
        name: "pvc-server-server-id",
        namespace: "fl-user",
        labels: { "farlands.dev/server-id": "server-id" },
      },
    } as k8s.V1PersistentVolumeClaim;
    expect(targetFromPvc(legacyPvc).serviceName).toBe("svc-server-server-id");
  });

  test("uses a validated promoted candidate service annotation", () => {
    const pvc = {
      metadata: {
        name: "pvc-cand-server-id-deadbeef",
        namespace: "fl-user",
        labels: {
          "farlands.dev/backup-server-id": "server-id",
          "farlands.dev/backup-strategy": "minecraft-rcon",
        },
        annotations: {
          "farlands.dev/backup-service": "svc-cand-server-id-deadbeef",
        },
      },
    } as k8s.V1PersistentVolumeClaim;

    const target = targetFromPvc(pvc);
    expect(target.serviceName).toBe("svc-cand-server-id-deadbeef");
    const job = buildBackupJob({ ...target, nodeName: "worker-node-a" }, config, "2026-w35");
    expect(
      job.spec?.template.spec?.initContainers?.[0]?.env?.find(
        (entry) => entry.name === "BACKUP_ENDPOINT",
      )?.value,
    ).toBe("http://svc-cand-server-id-deadbeef:8080/backup");

    pvc.metadata!.annotations!["farlands.dev/backup-service"] = "https://attacker.invalid/x";
    expect(() => targetFromPvc(pvc)).toThrow("farlands.dev/backup-service");
  });

  test("re-resolves the unique active PVC while the server Lease is held", async () => {
    const activePvc = {
      metadata: {
        name: "pvc-cand-server-id-deadbeef",
        namespace: "fl-user",
        labels: {
          "farlands.dev/backup-server-id": "server-id",
          "farlands.dev/backup-strategy": "minecraft-rcon",
        },
        annotations: {
          "farlands.dev/backup-service": "svc-cand-server-id-deadbeef",
        },
      },
    } as k8s.V1PersistentVolumeClaim;
    let request: { namespace: string; labelSelector?: string } | undefined;
    const core = {
      listNamespacedPersistentVolumeClaim: async (input: {
        namespace: string;
        labelSelector?: string;
      }) => {
        request = input;
        return { items: [activePvc] };
      },
    };
    const target = await resolveLeasedBackupTarget(core as never, {
      namespace: "fl-user",
      pvcName: "pvc-server-server-id",
      serverId: "server-id",
    });
    expect(target).toMatchObject({
      pvcName: "pvc-cand-server-id-deadbeef",
      serviceName: "svc-cand-server-id-deadbeef",
    });
    expect(request).toEqual({
      namespace: "fl-user",
      labelSelector: "farlands.dev/backup-strategy=minecraft-rcon",
    });

    const ambiguousCore = {
      listNamespacedPersistentVolumeClaim: async () => ({ items: [activePvc, activePvc] }),
    };
    expect(
      resolveLeasedBackupTarget(ambiguousCore as never, {
        namespace: "fl-user",
        pvcName: "pvc-server-server-id",
        serverId: "server-id",
      }),
    ).rejects.toThrow("exactly one active backup PVC");
  });

  test("accepts idempotent Jobs only when all weekly-run labels match", () => {
    const job = buildBackupJob(
      {
        namespace: "fl-user",
        pvcName: "pvc-server-id",
        serverId: "server-id",
      },
      config,
      "2026-w35",
    );

    expect(weeklyJobMatchesRun(job, "server-id", "2026-w35")).toBe(true);
    expect(weeklyJobMatchesRun(job, "different-server", "2026-w35")).toBe(false);
    expect(weeklyJobMatchesRun(job, "server-id", "2026-w36")).toBe(false);
  });

  test("recreates a terminal failed same-week Job only after foreground deletion", async () => {
    const target = {
      namespace: "fl-user",
      pvcName: "pvc-server-id",
      serverId: "server-id",
    };
    const job = buildBackupJob(target, config, "2026-w35", "pod-retry");
    const failed = {
      ...job,
      metadata: {
        ...job.metadata,
        uid: "failed-job-uid",
        resourceVersion: "41",
      },
      status: { conditions: [{ type: "Failed", status: "True" }] },
    } as k8s.V1Job;
    const operations: string[] = [];
    let createAttempt = 0;
    let readAttempt = 0;
    let fences = 0;
    let clock = 0;
    const batch = {
      createNamespacedJob: async () => {
        operations.push("create");
        createAttempt += 1;
        if (createAttempt === 1) throw { statusCode: 409 };
        return job;
      },
      readNamespacedJob: async () => {
        operations.push("read");
        readAttempt += 1;
        if (readAttempt <= 2) return failed;
        throw { statusCode: 404 };
      },
      deleteNamespacedJob: async (input: {
        propagationPolicy?: string;
        body?: { preconditions?: { uid?: string; resourceVersion?: string } };
      }) => {
        operations.push(
          `delete:${input.propagationPolicy}:${input.body?.preconditions?.uid}:${input.body?.preconditions?.resourceVersion}`,
        );
        return {};
      },
    };

    expect(
      await createOrReuseWeeklyJob(batch as never, target, job, "2026-w35", {
        timeoutMs: 100,
        pollIntervalMs: 1,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
        beforeCreate: async () => {
          fences += 1;
          return new Date(clock + 60_000);
        },
        requiredRemainingMs: 1_000,
      }),
    ).toBe("retried");
    expect(fences).toBe(3);
    expect(operations).toEqual([
      "create",
      "read",
      "read",
      "delete:Foreground:failed-job-uid:41",
      "read",
      "create",
    ]);
  });

  test("cannot delete a successor Job when a paused invocation resumes", async () => {
    const target = {
      namespace: "fl-user",
      pvcName: "pvc-server-id",
      serverId: "server-id",
    };
    const desired = buildBackupJob(target, config, "2026-w35", "pod-stale");
    const failed = {
      ...desired,
      metadata: { ...desired.metadata, uid: "old-failed-uid", resourceVersion: "7" },
      status: { conditions: [{ type: "Failed", status: "True" }] },
    } as k8s.V1Job;
    const successor = {
      ...desired,
      metadata: { ...desired.metadata, uid: "successor-uid", resourceVersion: "8" },
      status: {},
    } as k8s.V1Job;
    const operations: string[] = [];
    let liveJob = failed;
    let deletedUid: string | null = null;

    const batch = {
      createNamespacedJob: async () => {
        operations.push("create");
        throw { statusCode: 409 };
      },
      readNamespacedJob: async () => {
        operations.push(`read:${liveJob.metadata?.uid}`);
        return liveJob;
      },
      deleteNamespacedJob: async (input: {
        body?: { preconditions?: { uid?: string; resourceVersion?: string } };
      }) => {
        const preconditions = input.body?.preconditions;
        operations.push(`delete:${preconditions?.uid}:${preconditions?.resourceVersion}`);
        if (preconditions?.uid !== liveJob.metadata?.uid) throw { statusCode: 409 };
        deletedUid = liveJob.metadata?.uid ?? null;
        return {};
      },
    };

    await expect(
      createOrReuseWeeklyJob(batch as never, target, desired, "2026-w35", {
        now: () => 0,
        beforeCreate: async () => new Date(60_000),
        beforeDelete: async () => {
          operations.push("delete-fence");
          // Model the old process pausing while a successor replaces the
          // deterministic name. Kubernetes must reject the stale UID-bound
          // delete even if it reaches the API after this transition.
          liveJob = successor;
          return new Date(60_000);
        },
        requiredRemainingMs: 1_000,
      }),
    ).rejects.toEqual({ statusCode: 409 });

    expect(deletedUid).toBeNull();
    expect(operations).toEqual([
      "create",
      "read:old-failed-uid",
      "read:old-failed-uid",
      "delete-fence",
      "delete:old-failed-uid:7",
    ]);
  });

  test("rechecks the authoritative Lease deadline at the Job POST boundary", async () => {
    const target = {
      namespace: "fl-user",
      pvcName: "pvc-server-id",
      serverId: "server-id",
    };
    const job = buildBackupJob(target, config, "2026-w35", "pod-paused");
    let clock = 0;
    let creates = 0;
    const batch = {
      createNamespacedJob: async () => {
        creates += 1;
        return job;
      },
      readNamespacedJob: async () => job,
      deleteNamespacedJob: async () => ({}),
    };

    await expect(
      createOrReuseWeeklyJob(batch as never, target, job, "2026-w35", {
        now: () => clock,
        requiredRemainingMs: 5_000,
        beforeCreate: async () => {
          const authoritativeDeadline = new Date(10_000);
          clock = 5_001;
          return authoritativeDeadline;
        },
      }),
    ).rejects.toThrow("no longer covers the worker deadline");
    expect(creates).toBe(0);
  });

  test("never replaces a matching active same-week Job", async () => {
    const target = {
      namespace: "fl-user",
      pvcName: "pvc-server-id",
      serverId: "server-id",
    };
    const job = buildBackupJob(target, config, "2026-w35", "pod-resume");
    let deletes = 0;
    const batch = {
      createNamespacedJob: async () => {
        throw { statusCode: 409 };
      },
      readNamespacedJob: async () => job,
      deleteNamespacedJob: async () => {
        deletes += 1;
      },
    };

    expect(await createOrReuseWeeklyJob(batch as never, target, job, "2026-w35")).toBe(
      "reused",
    );
    expect(weeklyJobTerminalState(job)).toBe("active");
    expect(deletes).toBe(0);
  });

  test("retains the Lease after ambiguous Kubernetes create failures", () => {
    expect(kubernetesCreateErrorIsAmbiguous(new Error("socket reset"))).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ code: "ECONNRESET" })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 408 })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ response: { statusCode: 503 } })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ body: { code: 429 } })).toBe(true);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 403 })).toBe(false);
    expect(kubernetesCreateErrorIsAmbiguous({ statusCode: 422 })).toBe(false);
  });
});

describe("per-server operation lease", () => {
  test("expires from its renew time and uses a stable DNS-safe name", () => {
    const lease = {
      spec: {
        holderIdentity: "weekly:2026-w35",
        renewTime: new Date("2026-08-30T03:00:00Z"),
        leaseDurationSeconds: 120,
      },
    } as k8s.V1Lease;

    expect(backupLeaseName("SERVER_123")).toBe("backup-operation-server-123");
    expect(backupLeaseExpired(lease, new Date("2026-08-30T03:01:59Z"))).toBe(false);
    expect(backupLeaseExpired(lease, new Date("2026-08-30T03:02:00Z"))).toBe(true);
  });

  test("rejects stale same-week readback after an ambiguous renewal", () => {
    const holder = "weekly:2026-w35";
    const attemptedAt = new Date("2026-08-30T03:10:00Z");
    const stale = {
      spec: {
        holderIdentity: holder,
        renewTime: new Date("2026-08-30T03:00:00Z"),
        leaseDurationSeconds: 7_500,
      },
    } as k8s.V1Lease;
    const renewed = {
      spec: {
        holderIdentity: holder,
        renewTime: attemptedAt,
        leaseDurationSeconds: 7_500,
      },
    } as k8s.V1Lease;

    expect(weeklyLeaseReflectsMutation(stale, holder, 7_500, attemptedAt)).toBe(false);
    expect(weeklyLeaseReflectsMutation(renewed, holder, 7_500, attemptedAt)).toBe(true);
  });

  test("retries release conflicts and transient API failures", async () => {
    const outcomes: Array<boolean | Error> = [false, new Error("unavailable"), true];
    const delays: number[] = [];
    let attempt = 0;

    await retryWeeklyLeaseRelease(
      async () => {
        const outcome = outcomes[attempt++];
        if (outcome instanceof Error) throw outcome;
        return outcome ?? false;
      },
      {
        attempts: 3,
        initialBackoffMs: 10,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(attempt).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test("one concurrent invocation cannot release another invocation's Lease", async () => {
    const target = {
      namespace: "fl-user",
      pvcName: "pvc-server-id",
      serverId: "server-id",
    };
    const firstHolder = weeklyLeaseHolder("2026-w35", "pod-a");
    const secondHolder = weeklyLeaseHolder("2026-w35", "pod-b");
    let deleteCalls = 0;
    const coordination = {
      readNamespacedLease: async () =>
        ({
          metadata: { resourceVersion: "2", uid: "lease-uid" },
          spec: { holderIdentity: secondHolder },
        }) as k8s.V1Lease,
      deleteNamespacedLease: async () => {
        deleteCalls += 1;
      },
    };

    expect(
      await releaseWeeklyBackupLease(coordination as never, target, firstHolder),
    ).toBe(true);
    expect(deleteCalls).toBe(0);
    expect(
      await releaseWeeklyBackupLease(coordination as never, target, secondHolder),
    ).toBe(true);
    expect(deleteCalls).toBe(1);
  });
});

describe("bounded orchestration", () => {
  test("does not exceed the configured concurrency and preserves failures", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (value === 3) throw new Error("expected failure");
      return value * 2;
    });

    expect(peak).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
