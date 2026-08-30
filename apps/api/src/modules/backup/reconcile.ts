import { randomUUID } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { backups, gameServers, serverK8s } from "@repo/db/schema";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";

import { db } from "../../db";
import { assertNoPendingServerCutover } from "../deploy/guard";
import {
  getKubernetesStatusCode,
  type KubernetesClients,
  makeKubernetesClients,
  waitForDeploymentRolloutReady,
} from "../provisioning/kubernetes";
import {
  ensureTenantNamespace,
  RCON_PASSWORD_FILE,
  RCON_PASSWORD_MOUNT,
  RCON_PORT,
  RCON_SECRET_NAME,
  tenantNamespace,
  WORLD_SYNC_NAMES,
  WORLD_SYNC_PORT,
  WORLD_SYNC_ROOT,
} from "../provisioning/tenancy";
import { requiredPinnedImage } from "../provisioning/utils";
import {
  acquireBackupLease,
  releaseBackupLeaseWithRetry,
  SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
} from "./lock";

const BACKUP_STRATEGY = "minecraft-rcon";
const BACKUP_APP_NAME = "farlands-game-server";
const BACKUP_ROOT = "/data";
const RECONCILIATION_LEASE_RENEW_INTERVAL_MS =
  (SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS * 1_000) / 3;
const RECONCILIATION_LEASE_RENEW_ATTEMPTS = 3;

export type LegacyBackupRealm = {
  serverId: string;
  userId: string;
  namespace: string;
  deploymentName: string;
  serviceName: string;
  pvcName: string;
};

export type ReconcileResult = LegacyBackupRealm & {
  changed: boolean;
  desiredReplicas: number;
};

export async function assertNoActiveBackupDatabaseClaim(serverId: string): Promise<void> {
  const [active] = await db
    .select({
      id: backups.id,
      operation: backups.activeOperation,
      status: backups.status,
    })
    .from(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        or(isNotNull(backups.activeOperation), inArray(backups.status, ["pending", "in_progress"])),
      ),
    )
    .limit(1);

  if (active) {
    throw new Error(
      `Refusing to reconcile ${serverId}: backup '${active.id}' still has ` +
        `${active.operation ?? active.status} work in progress`,
    );
  }
}

export async function assertLegacyBackupReconciliationReady(
  realm: LegacyBackupRealm,
): Promise<string> {
  const expectedNamespace = tenantNamespace(realm.userId);
  if (expectedNamespace !== realm.namespace) {
    throw new Error(
      `Refusing to reconcile ${realm.serverId}: database namespace '${realm.namespace}' does not match tenant namespace '${expectedNamespace}'`,
    );
  }
  await assertNoPendingServerCutover(realm.serverId);
  await assertNoActiveBackupDatabaseClaim(realm.serverId);
  return expectedNamespace;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function upsertNamed<T extends { name?: string }>(items: T[] | undefined, desired: T): T[] {
  const next = [...(items ?? [])];
  const index = next.findIndex((item) => item.name === desired.name);
  if (index === -1) next.push(desired);
  else next[index] = desired;
  return next;
}

function findServerDataVolumeName(deployment: k8s.V1Deployment, pvcName: string): string {
  const volume = deployment.spec?.template.spec?.volumes?.find(
    (candidate) => candidate.persistentVolumeClaim?.claimName === pvcName,
  );
  if (!volume?.name) {
    throw new Error(
      `Deployment '${deployment.metadata?.name}' does not mount expected PVC '${pvcName}'`,
    );
  }
  return volume.name;
}

function worldSyncContainer(dataVolumeName: string): k8s.V1Container {
  return {
    name: "world-sync",
    image: requiredPinnedImage("FARLANDS_WORLD_SYNC_IMAGE"),
    imagePullPolicy: "IfNotPresent",
    command: ["python3", "/sync/sender.py"],
    ports: [{ name: "world-sync", containerPort: WORLD_SYNC_PORT, protocol: "TCP" }],
    env: [
      { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
      { name: "WORLD_ROOT", value: WORLD_SYNC_ROOT },
      { name: "WORLD_NAMES", value: WORLD_SYNC_NAMES },
      { name: "BACKUP_ROOT", value: BACKUP_ROOT },
      { name: "RCON_HOST", value: "127.0.0.1" },
      { name: "RCON_PORT", value: String(RCON_PORT) },
      { name: "RCON_PASSWORD_FILE", value: RCON_PASSWORD_FILE },
      { name: "PYTHONDONTWRITEBYTECODE", value: "1" },
    ],
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "200m", memory: "128Mi" },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
    },
    volumeMounts: [
      { name: dataVolumeName, mountPath: BACKUP_ROOT, readOnly: true },
      { name: "world-sync", mountPath: "/sync", readOnly: true },
      { name: "rcon", mountPath: RCON_PASSWORD_MOUNT, readOnly: true },
    ],
  };
}

export function buildReconciledDeployment(
  existing: k8s.V1Deployment,
  realm: Pick<LegacyBackupRealm, "serverId" | "pvcName">,
  configMapName = `cm-server-${realm.serverId}`,
): k8s.V1Deployment {
  const desired = structuredClone(existing);
  const podSpec = desired.spec?.template.spec;
  if (!desired.spec?.template.metadata || !podSpec) {
    throw new Error(`Deployment '${existing.metadata?.name}' has no pod template`);
  }

  const dataVolumeName = findServerDataVolumeName(desired, realm.pvcName);
  const gameContainer = podSpec.containers.find((container) => container.name === "game-server");
  if (!gameContainer) {
    throw new Error(`Deployment '${existing.metadata?.name}' has no game-server container`);
  }

  desired.metadata = {
    ...desired.metadata,
    labels: {
      ...desired.metadata?.labels,
      "app.kubernetes.io/name": BACKUP_APP_NAME,
      "farlands.dev/backup-server-id": realm.serverId,
    },
  };
  desired.spec.strategy = { type: "Recreate" };
  desired.spec.template.metadata.labels = {
    ...desired.spec.template.metadata.labels,
    "app.kubernetes.io/name": BACKUP_APP_NAME,
    "farlands.dev/backup-server-id": realm.serverId,
  };

  gameContainer.ports = upsertNamed(gameContainer.ports, {
    name: "rcon",
    containerPort: RCON_PORT,
    protocol: "TCP",
  });
  gameContainer.volumeMounts = upsertNamed(gameContainer.volumeMounts, {
    name: "rcon",
    mountPath: RCON_PASSWORD_MOUNT,
    readOnly: true,
  });
  if (!gameContainer.envFrom?.some((source) => source.configMapRef?.name === configMapName)) {
    gameContainer.envFrom = [
      ...(gameContainer.envFrom ?? []),
      { configMapRef: { name: configMapName } },
    ];
  }
  podSpec.containers = upsertNamed(podSpec.containers, worldSyncContainer(dataVolumeName));
  podSpec.volumes = upsertNamed(podSpec.volumes, {
    name: "world-sync",
    configMap: { name: "cm-world-sync" },
  });
  podSpec.volumes = upsertNamed(podSpec.volumes, {
    name: "rcon",
    secret: { secretName: RCON_SECRET_NAME },
  });

  return desired;
}

export function buildReconciledConfigMap(existing: k8s.V1ConfigMap): k8s.V1ConfigMap {
  return {
    ...structuredClone(existing),
    data: {
      ...existing.data,
      ENABLE_RCON: "true",
      RCON_PASSWORD_FILE,
      RCON_PORT: String(RCON_PORT),
    },
  };
}

export function buildReconciledService(existing: k8s.V1Service): k8s.V1Service {
  const desired = structuredClone(existing);
  if (!desired.spec) throw new Error(`Service '${existing.metadata?.name}' has no spec`);
  desired.spec.ports = upsertNamed(desired.spec.ports, {
    name: "world-sync",
    port: WORLD_SYNC_PORT,
    targetPort: WORLD_SYNC_PORT,
    protocol: "TCP",
  });
  return desired;
}

export function buildBackupNetworkPolicy(namespace: string, serverId: string): k8s.V1NetworkPolicy {
  return {
    metadata: {
      name: `netpol-backup-${serverId}`,
      namespace,
      labels: {
        "app.kubernetes.io/name": BACKUP_APP_NAME,
        "app.kubernetes.io/managed-by": "farlands-backend",
        "farlands.dev/backup-server-id": serverId,
      },
    },
    spec: {
      podSelector: { matchLabels: { "farlands.dev/backup-server-id": serverId } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            { podSelector: { matchLabels: { app: "server-backup-worker" } } },
            {
              podSelector: {
                matchLabels: { "app.kubernetes.io/name": BACKUP_APP_NAME },
              },
            },
          ],
          ports: [{ protocol: "TCP", port: WORLD_SYNC_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
      ],
    },
  };
}

export function buildDiscoverablePvc(
  existing: k8s.V1PersistentVolumeClaim,
  realm: Pick<LegacyBackupRealm, "serverId" | "serviceName">,
): k8s.V1PersistentVolumeClaim {
  const desired = structuredClone(existing);
  desired.metadata = {
    ...desired.metadata,
    labels: {
      ...desired.metadata?.labels,
      "app.kubernetes.io/name": BACKUP_APP_NAME,
      "farlands.dev/backup-strategy": BACKUP_STRATEGY,
      "farlands.dev/backup-server-id": realm.serverId,
    },
    annotations: {
      ...desired.metadata?.annotations,
      "farlands.dev/backup-service": realm.serviceName,
    },
  };
  return desired;
}

function configMapNameForDeployment(deployment: k8s.V1Deployment, serverId: string): string {
  const gameContainer = deployment.spec?.template.spec?.containers.find(
    (container) => container.name === "game-server",
  );
  return (
    gameContainer?.envFrom?.find((source) => source.configMapRef?.name)?.configMapRef?.name ??
    `cm-server-${serverId}`
  );
}

async function replaceNetworkPolicy(
  clients: KubernetesClients,
  desired: k8s.V1NetworkPolicy,
  namespace: string,
  assertLeaseHeld: () => Promise<void>,
): Promise<boolean> {
  const name = desired.metadata?.name;
  if (!name) throw new Error("Backup NetworkPolicy is missing a name");
  try {
    const existing = await clients.networking.readNamespacedNetworkPolicy({ name, namespace });
    if (
      same(existing.spec, desired.spec) &&
      same(existing.metadata?.labels, desired.metadata?.labels)
    ) {
      return false;
    }
    desired.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await assertLeaseHeld();
    await clients.networking.replaceNamespacedNetworkPolicy({ name, namespace, body: desired });
    return true;
  } catch (error) {
    if (getKubernetesStatusCode(error) !== 404) throw error;
    await assertLeaseHeld();
    await clients.networking.createNamespacedNetworkPolicy({ namespace, body: desired });
    return true;
  }
}

async function withReconciliationLease<T>(
  realm: LegacyBackupRealm,
  run: (assertLeaseHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const leaseHolder = `backup-reconcile:${randomUUID()}`;
  const initialDeadline = await acquireBackupLease(
    realm.namespace,
    realm.serverId,
    leaseHolder,
    SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
  );
  let renewalPromise: Promise<void> | null = null;
  let lastRenewalError: unknown;
  let confirmedUntil = initialDeadline.getTime();

  const renewOnce = async (): Promise<void> => {
    const previousConfirmedUntil = confirmedUntil;
    if (Date.now() >= previousConfirmedUntil) {
      throw new Error("Backup reconciliation Lease ownership window expired before renewal");
    }
    const renewedDeadline = await acquireBackupLease(
      realm.namespace,
      realm.serverId,
      leaseHolder,
      SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
    );
    const confirmedAt = Date.now();
    if (confirmedAt >= previousConfirmedUntil) {
      throw new Error(
        "Backup reconciliation Lease renewal completed after its ownership window expired",
      );
    }
    if (confirmedAt >= renewedDeadline.getTime()) {
      throw new Error(
        "Backup reconciliation Lease renewal response arrived after the renewed Lease expired",
      );
    }
    confirmedUntil = renewedDeadline.getTime();
    lastRenewalError = undefined;
  };

  const renewInBackground = () => {
    if (renewalPromise) return;
    renewalPromise = renewOnce()
      .catch((error) => {
        lastRenewalError = error;
      })
      .finally(() => {
        renewalPromise = null;
      });
  };

  const assertLeaseHeld = async (): Promise<void> => {
    if (Date.now() >= confirmedUntil) {
      throw new Error("Backup reconciliation Lease ownership window expired");
    }
    if (renewalPromise) await renewalPromise;
    let error = lastRenewalError;
    for (let attempt = 1; attempt <= RECONCILIATION_LEASE_RENEW_ATTEMPTS; attempt += 1) {
      try {
        await renewOnce();
        return;
      } catch (renewError) {
        error = renewError;
        lastRenewalError = renewError;
        if (attempt < RECONCILIATION_LEASE_RENEW_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        }
      }
    }
    const fenced = new Error("Could not confirm the backup reconciliation Lease");
    (fenced as Error & { cause?: unknown }).cause = error;
    throw fenced;
  };

  const timer = setInterval(renewInBackground, RECONCILIATION_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();

  let result: T | undefined;
  let operationError: unknown;
  try {
    await assertLeaseHeld();
    result = await run(assertLeaseHeld);
    await assertLeaseHeld();
  } catch (error) {
    operationError = error;
  }

  clearInterval(timer);
  await renewalPromise;

  let releaseError: unknown;
  try {
    await releaseBackupLeaseWithRetry(realm.namespace, realm.serverId, leaseHolder);
  } catch (error) {
    releaseError = error;
  }

  if (operationError) {
    if (releaseError) {
      console.error(`[${realm.serverId}] Backup reconciliation Lease release failed`, releaseError);
    }
    throw operationError;
  }
  if (releaseError) throw releaseError;
  return result as T;
}

export async function reconcileLegacyMinecraftBackup(
  realm: LegacyBackupRealm,
  clients: KubernetesClients = makeKubernetesClients(),
): Promise<ReconcileResult> {
  return withReconciliationLease(realm, async (assertLeaseHeld) => {
    const expectedNamespace = await assertLegacyBackupReconciliationReady(realm);
    const managedNamespace = await ensureTenantNamespace(realm.userId, clients, assertLeaseHeld);
    if (managedNamespace !== expectedNamespace) {
      throw new Error(
        `Tenant namespace reconciliation returned '${managedNamespace}', expected '${expectedNamespace}'`,
      );
    }

    const [deployment, service, pvc] = await Promise.all([
      clients.apps.readNamespacedDeployment({
        name: realm.deploymentName,
        namespace: realm.namespace,
      }),
      clients.core.readNamespacedService({ name: realm.serviceName, namespace: realm.namespace }),
      clients.core.readNamespacedPersistentVolumeClaim({
        name: realm.pvcName,
        namespace: realm.namespace,
      }),
    ]);
    const desiredReplicas = deployment.spec?.replicas ?? 1;
    const configMapName = configMapNameForDeployment(deployment, realm.serverId);
    const configMap = await clients.core.readNamespacedConfigMap({
      name: configMapName,
      namespace: realm.namespace,
    });
    let changed = false;
    const desiredConfigMap = buildReconciledConfigMap(configMap);
    const desiredService = buildReconciledService(service);
    const desiredDeployment = buildReconciledDeployment(deployment, realm, configMapName);
    const desiredPvc = buildDiscoverablePvc(pvc, realm);

    // Pre-upgrade Jobs did not acquire the Kubernetes Lease. Re-check their
    // durable database claim immediately before the first workload mutation.
    await assertNoActiveBackupDatabaseClaim(realm.serverId);

    if (!same(configMap.data, desiredConfigMap.data)) {
      await assertLeaseHeld();
      await clients.core.replaceNamespacedConfigMap({
        name: configMapName,
        namespace: realm.namespace,
        body: desiredConfigMap,
      });
      changed = true;
    }

    if (!same(service.spec, desiredService.spec)) {
      await assertLeaseHeld();
      await clients.core.replaceNamespacedService({
        name: realm.serviceName,
        namespace: realm.namespace,
        body: desiredService,
      });
      changed = true;
    }

    changed =
      (await replaceNetworkPolicy(
        clients,
        buildBackupNetworkPolicy(realm.namespace, realm.serverId),
        realm.namespace,
        assertLeaseHeld,
      )) || changed;

    const deploymentSpecChanged = !same(deployment.spec, desiredDeployment.spec);
    const deploymentMetadataChanged = !same(
      deployment.metadata?.labels,
      desiredDeployment.metadata?.labels,
    );
    if (deploymentSpecChanged || deploymentMetadataChanged) {
      await assertLeaseHeld();
      const replaced = await clients.apps.replaceNamespacedDeployment({
        name: realm.deploymentName,
        namespace: realm.namespace,
        body: desiredDeployment,
      });
      if (deploymentSpecChanged) {
        const minimumGeneration =
          replaced.metadata?.generation ?? (deployment.metadata?.generation ?? 0) + 1;
        await waitForDeploymentRolloutReady(
          clients.apps,
          realm.deploymentName,
          realm.namespace,
          desiredReplicas,
          minimumGeneration,
        );
        await assertLeaseHeld();
      }
      changed = true;
    }

    // Discovery is deliberately enabled last. A failed partial reconciliation
    // therefore cannot cause the weekly CronJob to target an unready workload.
    if (
      !same(pvc.metadata?.labels, desiredPvc.metadata?.labels) ||
      !same(pvc.metadata?.annotations, desiredPvc.metadata?.annotations)
    ) {
      await assertNoActiveBackupDatabaseClaim(realm.serverId);
      await assertLeaseHeld();
      await clients.core.replaceNamespacedPersistentVolumeClaim({
        name: realm.pvcName,
        namespace: realm.namespace,
        body: desiredPvc,
      });
      changed = true;
    }

    return { ...realm, changed, desiredReplicas };
  });
}

export async function listLegacyMinecraftBackupRealms(): Promise<LegacyBackupRealm[]> {
  return db
    .select({
      serverId: gameServers.id,
      userId: gameServers.userId,
      namespace: serverK8s.namespace,
      deploymentName: serverK8s.deploymentName,
      serviceName: serverK8s.serviceName,
      pvcName: serverK8s.pvcName,
    })
    .from(gameServers)
    .innerJoin(serverK8s, eq(serverK8s.serverId, gameServers.id))
    .where(and(eq(gameServers.game, "minecraft"), ne(gameServers.currentState, "deleted")));
}

export async function reconcileAllLegacyMinecraftBackups(
  clients: KubernetesClients = makeKubernetesClients(),
): Promise<ReconcileResult[]> {
  const realms = await listLegacyMinecraftBackupRealms();
  const results: ReconcileResult[] = [];
  for (const realm of realms) {
    results.push(await reconcileLegacyMinecraftBackup(realm, clients));
  }
  return results;
}
