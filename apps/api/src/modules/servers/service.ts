import type * as k8s from "@kubernetes/client-node";
import {
  controlPlaneEvents,
  gameServers,
  operatorReceipts,
  serverConfigs,
  serverK8s,
  serverRoutes,
} from "@repo/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { status } from "elysia";
import { db, type TransactionType } from "../../db";
import {
  acquireBackupLease,
  assertBackupLeaseFence,
  assertBackupLeaseRenewalFence,
  BackupOperationBusyError,
  releaseBackupLeaseWithRetry,
  SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
} from "../backup/lock";
import {
  BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE,
  backupRestoreRecoveryRequired,
} from "../backup/model";
import {
  assertNoActiveServerBackup,
  assertNoPendingServerCutover,
  ServerBackupInProgressError,
  ServerCutoverInProgressError,
} from "../deploy/guard";
import { deleteGameServer, provisionGameServer } from "../provisioning";
import {
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
  waitForDeploymentRolloutReady,
} from "../provisioning/kubernetes";
import { calculateContainerMemory } from "../provisioning/utils";
import { assertAllocationFits, QuotaService } from "../quota/quota.service";
import {
  type CreateServerInput,
  type ServerActionInput,
  serverActionDto,
  type UpdateServerConfigInput,
} from "./model";
import { getMinecraftRouteHostname } from "./routing";

const ACTIVE_SERVER_NAME_INDEX = "game_servers_user_active_name_idx";
const SERVER_BACKUP_LEASE_RENEW_INTERVAL_MS = Math.max(
  1_000,
  Math.floor((SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS * 1_000) / 3),
);
type ServerBackupLeaseFence = () => Promise<void>;

async function withServerBackupLease<T>(
  namespace: string,
  serverId: string,
  operation: string,
  run: (assertLeaseHeld: ServerBackupLeaseFence) => Promise<T>,
): Promise<T> {
  const holder = `${operation}:${crypto.randomUUID()}`;
  let confirmedUntil: number;
  try {
    confirmedUntil = (
      await acquireBackupLease(
        namespace,
        serverId,
        holder,
        SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
      )
    ).getTime();
    assertBackupLeaseFence(confirmedUntil);
  } catch (error) {
    if (error instanceof BackupOperationBusyError) {
      throw status(409, "Wait for the active backup or restore operation to finish");
    }
    throw error;
  }

  let renewalInFlight: Promise<void> | null = null;
  let renewalFailure: unknown = null;
  let renewalsStopped = false;
  const renewOnce = (): Promise<void> => {
    if (renewalsStopped) {
      return Promise.reject(new Error("Server backup Lease renewal has stopped"));
    }
    if (renewalInFlight) return renewalInFlight;

    const previousConfirmedUntil = confirmedUntil;
    const requestStartedAt = Date.now();
    try {
      assertBackupLeaseFence(previousConfirmedUntil, requestStartedAt);
    } catch (error) {
      renewalFailure = error;
      return Promise.reject(error);
    }
    let activeRenewal!: Promise<void>;
    activeRenewal = (async () => {
      try {
        const renewedUntil = await acquireBackupLease(
          namespace,
          serverId,
          holder,
          SYNCHRONOUS_SERVER_OPERATION_LEASE_SECONDS,
        );
        const responseReceivedAt = Date.now();
        assertBackupLeaseRenewalFence(
          previousConfirmedUntil,
          renewedUntil.getTime(),
          requestStartedAt,
          responseReceivedAt,
        );
        confirmedUntil = renewedUntil.getTime();
        renewalFailure = null;
      } catch (error) {
        renewalFailure = error;
        throw error;
      } finally {
        if (renewalInFlight === activeRenewal) renewalInFlight = null;
      }
    })();
    renewalInFlight = activeRenewal;
    return activeRenewal;
  };

  const settleRenewal = async (): Promise<void> => {
    const activeRenewal = renewalInFlight;
    if (activeRenewal) {
      try {
        await activeRenewal;
      } catch (error) {
        renewalFailure = error;
      }
    }
    if (renewalFailure !== null) {
      // Retry a transient renewal only while the last authoritative ownership
      // window remains live. renewOnce checks the old deadline before issuing
      // a request and rejects any response that arrives after that deadline.
      assertBackupLeaseFence(confirmedUntil);
      await renewOnce();
    }
    assertBackupLeaseFence(confirmedUntil);
  };

  const assertLeaseHeld: ServerBackupLeaseFence = async () => {
    await settleRenewal();
    // Old API Jobs did not take the Lease. Re-check their durable database
    // claims at every mutation boundary, not only when this request entered.
    await assertNoActiveServerBackup(serverId);
    await assertNoPendingServerCutover(serverId);
    await settleRenewal();
  };

  const renewalTimer = setInterval(() => {
    if (renewalsStopped) return;
    void renewOnce().catch((error) => {
      console.error(`[${serverId}] Failed to renew ${operation} backup lease:`, error);
    });
  }, SERVER_BACKUP_LEASE_RENEW_INTERVAL_MS);
  renewalTimer.unref?.();

  const awaitInFlightRenewalBeforeRelease = async (): Promise<void> => {
    const activeRenewal = renewalInFlight;
    if (!activeRenewal) return;
    await activeRenewal.catch((error: unknown) => {
      console.error(
        `[${serverId}] ${operation} Lease renewal failed before release completed:`,
        error,
      );
    });
  };

  try {
    await assertLeaseHeld();
    return await run(assertLeaseHeld);
  } catch (error) {
    if (error instanceof ServerBackupInProgressError) {
      throw status(409, "Wait for the active backup or restore operation to finish");
    }
    if (error instanceof ServerCutoverInProgressError) {
      throw status(409, "Wait for the active deployment cutover to finish");
    }
    throw error;
  } finally {
    renewalsStopped = true;
    clearInterval(renewalTimer);
    await awaitInFlightRenewalBeforeRelease();
    await releaseBackupLeaseWithRetry(namespace, serverId, holder).catch((error) => {
      console.error(`[${serverId}] Failed to release ${operation} backup lease:`, error);
    });
  }
}

function isActiveNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: unknown;
  };

  if (candidate.code === "23505") {
    return candidate.constraint === ACTIVE_SERVER_NAME_INDEX;
  }

  if (candidate.cause) {
    return isActiveNameConflict(candidate.cause);
  }

  return false;
}

function buildIdBasedServerName(prefix: string, serverId: string): string {
  const slug = serverId.replace(/-/g, "").toLowerCase();
  return `${prefix}-${slug}`.slice(0, 50);
}

function buildRandomFallbackServerName(prefix: string): string {
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}-${slug}`.slice(0, 50);
}

function buildRestoredServerName(originalName: string, serverId: string): string {
  const suffix = serverId.slice(0, 8);
  const restoredName = `${originalName}-restore-${suffix}`;

  if (restoredName.length <= 50) {
    return restoredName;
  }

  const prefixLength = 50 - "-restore-".length - suffix.length;
  return `${originalName.slice(0, Math.max(prefixLength, 1))}-restore-${suffix}`;
}

function buildRestoreNameCandidates(originalName: string, serverId: string): string[] {
  return [
    originalName,
    buildRestoredServerName(originalName, serverId),
    buildIdBasedServerName("restore", serverId),
    buildRandomFallbackServerName("restore"),
  ];
}

async function restoreServerAfterFailedDeletion(
  serverId: string,
  previousState: StateType,
  previousDesiredState: DesiredStateType,
  previousStatusMessage: string | null,
) {
  const [server] = await db
    .select({ name: gameServers.name })
    .from(gameServers)
    .where(eq(gameServers.id, serverId))
    .limit(1);

  if (!server) return;

  const baseRestore = {
    currentState: previousState,
    desiredState: previousDesiredState,
    updatedAt: new Date(),
  };

  const renamedMessage =
    "Failed to delete server resources and the original name was taken. Server restored under a new name. Please contact support.";
  const preservedRestoreMessage =
    previousStatusMessage === "Restoring backup" ||
    backupRestoreRecoveryRequired(previousStatusMessage)
      ? previousStatusMessage
      : null;

  const candidates = buildRestoreNameCandidates(server.name, serverId);

  for (const [index, candidateName] of candidates.entries()) {
    try {
      await db
        .update(gameServers)
        .set({
          ...baseRestore,
          name: candidateName,
          statusMessage:
            preservedRestoreMessage ??
            (index === 0
              ? "Failed to delete server resources. Please contact support."
              : renamedMessage),
        })
        .where(
          and(
            eq(gameServers.id, serverId),
            eq(gameServers.currentState, "deleted"),
            eq(gameServers.desiredState, "deleted"),
          ),
        );
      return;
    } catch (error) {
      if (!isActiveNameConflict(error)) {
        throw error;
      }
    }
  }

  // Last resort: keep generating random names until one succeeds.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db
        .update(gameServers)
        .set({
          ...baseRestore,
          name: buildRandomFallbackServerName("restore"),
          statusMessage: preservedRestoreMessage ?? renamedMessage,
        })
        .where(
          and(
            eq(gameServers.id, serverId),
            eq(gameServers.currentState, "deleted"),
            eq(gameServers.desiredState, "deleted"),
          ),
        );
      return;
    } catch (error) {
      if (!isActiveNameConflict(error)) {
        throw error;
      }
    }
  }

  throw status(
    500,
    "Failed to restore server state after an incomplete delete. Please contact support.",
  );
}

let cachedAppsApi: k8s.AppsV1Api | null = null;
function getAppsApi(): k8s.AppsV1Api {
  if (cachedAppsApi) return cachedAppsApi;

  try {
    // Reuse the provisioning client's EKS-aware TLS and authentication setup.
    // KubeConfig.makeApiClient() uses native fetch locally and fails to verify
    // the EKS certificate chain in this environment.
    cachedAppsApi = makeKubernetesClients().apps;
    return cachedAppsApi;
  } catch (err) {
    console.error("Failed to load Kubernetes client config:", err);
    throw status(503, "Kubernetes is not reachable right now. Please try again later.");
  }
}

type ServerState =
  | "ready"
  | "running"
  | "stopped"
  | "deleted"
  | "provisioning"
  | "starting"
  | "stopping"
  | "restarting"
  | "failed";

type DesiredServerState = "ready" | "running" | "stopped" | "deleted";

const VALID_FROM_STATES: Record<ServerActionInput["action"], readonly ServerState[]> = {
  start: ["stopped", "ready", "failed"] as const,
  stop: ["running", "starting", "failed"] as const,
  restart: ["running"] as const,
};

const TARGET_STATE: Record<ServerActionInput["action"], ServerState> = {
  start: "starting",
  stop: "stopping",
  restart: "restarting",
};

const DESIRED_STATE: Record<ServerActionInput["action"], DesiredServerState> = {
  start: "running",
  stop: "stopped",
  restart: "running",
};

const REPLICA_TARGET: Record<ServerActionInput["action"], number> = {
  start: 1,
  stop: 0,
  restart: 0,
};

const VALID_GAMES = ["minecraft", "rust", "cs2"] as const;
const VALID_STATES = [
  "ready",
  "running",
  "stopped",
  "deleted",
  "provisioning",
  "starting",
  "stopping",
  "restarting",
  "failed",
] as const;
const VALID_DESIRED_STATES = ["ready", "running", "stopped", "deleted"] as const;
type GameType = (typeof VALID_GAMES)[number];
type StateType = (typeof VALID_STATES)[number];
type DesiredStateType = (typeof VALID_DESIRED_STATES)[number];

export type OperatorReceiptDisposition = "create" | "reuse" | "retry" | "conflict";

export function operatorReceiptDisposition(
  existing: { serverId: string; action: string; status: string } | null,
  serverId: string,
  action: ServerActionInput["action"],
): OperatorReceiptDisposition {
  if (!existing) return "create";
  if (existing.serverId !== serverId || existing.action !== action) return "conflict";
  if (existing.status === "failed" || existing.status === "refused") return "retry";
  return "reuse";
}

export abstract class ServerService {
  private static readonly selection = {
    id: gameServers.id,
    name: gameServers.name,
    game: gameServers.game,
    currentState: gameServers.currentState,
    desiredState: gameServers.desiredState,
    statusMessage: gameServers.statusMessage,
    version: serverConfigs.version,
    type: serverConfigs.type,
    cpuCores: serverConfigs.cpuCores,
    ramMb: serverConfigs.ramMb,
    storageGb: serverConfigs.storageGb,
    hostname: serverRoutes.hostname,
    ip: serverRoutes.ip,
    port: serverRoutes.port,
    createdAt: gameServers.createdAt,
    updatedAt: gameServers.updatedAt,
  };

  static async getAllByUser(userId: string) {
    return db
      .select(ServerService.selection)
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(and(eq(gameServers.userId, userId), ne(gameServers.currentState, "deleted")))
      .orderBy(desc(gameServers.createdAt));
  }

  static async getById(userId: string, serverId: string) {
    const [server] = await db
      .select(ServerService.selection)
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)))
      .limit(1);

    if (!server) throw status(404, "Server not found");
    return server;
  }

  static async hasOwnership(userId: string, serverId: string) {
    const server = await db.query.gameServers.findFirst({
      columns: { id: true },
      where: and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)),
    });

    return Boolean(server);
  }

  static async getOwnerId(serverId: string) {
    const server = await db.query.gameServers.findFirst({
      columns: { userId: true },
      where: and(eq(gameServers.id, serverId), ne(gameServers.currentState, "deleted")),
    });

    if (!server) throw status(404, "Server not found");
    return server.userId;
  }

  static async requireOwnership(userId: string, serverId: string) {
    const [server] = await db
      .select({
        id: gameServers.id,
        game: gameServers.game,
        currentState: gameServers.currentState,
        desiredState: gameServers.desiredState,
        statusMessage: gameServers.statusMessage,
      })
      .from(gameServers)
      .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)));
    if (!server) throw status(404, "Server not found");
    return server;
  }

  static async getInternalServers(game?: string, status?: string) {
    const validGame = VALID_GAMES.includes(game as GameType) ? (game as GameType) : undefined;
    const validState = status
      ? VALID_STATES.includes(status as StateType)
        ? (status as StateType)
        : undefined
      : "running";
    return db
      .select({
        name: gameServers.id,
        game: gameServers.game,
        status: gameServers.currentState,
        hostname: serverRoutes.hostname,
        // routingHostname: serverRoutes.hostname,
        proxyTarget: serverRoutes.proxyTarget,
        ip: serverRoutes.ip,
        port: serverRoutes.port,
      })
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(
        validGame && validState
          ? and(eq(gameServers.game, validGame), eq(gameServers.currentState, validState))
          : validGame
            ? eq(gameServers.game, validGame)
            : validState
              ? eq(gameServers.currentState, validState)
              : undefined,
      );
  }

  static async getK8sRecord(serverId: string) {
    const k8sRecord = await db.query.serverK8s.findFirst({
      where: eq(serverK8s.serverId, serverId),
    });
    if (!k8sRecord) throw status(404, "Server has no associated Kubernetes resources");
    return k8sRecord;
  }

  private static async claimTransition(
    userId: string,
    serverId: string,
    action: ServerActionInput["action"],
  ) {
    const validStates = VALID_FROM_STATES[action];
    const targetState = TARGET_STATE[action];
    const targetDesired = DESIRED_STATE[action];

    const [claimed] = await db
      .update(gameServers)
      .set({
        currentState: targetState,
        desiredState: targetDesired,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameServers.id, serverId),
          eq(gameServers.userId, userId),
          inArray(gameServers.currentState, validStates),
        ),
      )
      .returning({
        currentState: gameServers.currentState,
        desiredState: gameServers.desiredState,
      });

    if (claimed) return claimed;

    const exists = await db.query.gameServers.findFirst({
      columns: { id: true },
      where: and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)),
    });

    if (!exists) throw status(404, "Server not found");

    throw status(409, `Cannot ${action} server: it is not in a valid state for this action`);
  }

  private static async setReplicas(
    appsApi: k8s.AppsV1Api,
    deploymentName: string,
    namespace: string,
    replicas: number,
    assertLeaseHeld: ServerBackupLeaseFence,
  ) {
    await assertLeaseHeld();
    return appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: replicas }],
      fieldManager: "farlands-backend",
    });
  }

  private static async triggerRollingRestart(
    deploymentName: string,
    namespace: string,
    targetReplicas: number,
    assertLeaseHeld: ServerBackupLeaseFence,
  ) {
    const appsApi = getAppsApi();
    await assertLeaseHeld();
    const restartedDeployment = await appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [
        {
          op: "add",
          path: "/spec/template/metadata/annotations",
          value: {
            "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
          },
        },
      ],
      fieldManager: "farlands-backend",
    });
    const restartGeneration = restartedDeployment.metadata?.generation;
    if (!restartGeneration) {
      throw new Error("Kubernetes did not return a restart generation");
    }

    await waitForDeploymentRolloutReady(
      appsApi,
      deploymentName,
      namespace,
      targetReplicas,
      restartGeneration,
    );
  }

  private static async settleState(
    serverId: string,
    currentState: "running" | "stopped",
    desiredState: "running" | "stopped",
  ) {
    await db
      .update(gameServers)
      .set({ currentState, desiredState, updatedAt: new Date() })
      .where(eq(gameServers.id, serverId));
  }

  private static async rollbackToPreviousState(
    serverId: string,
    previousState: {
      currentState: ServerState;
      desiredState: DesiredServerState;
    },
  ) {
    try {
      await db
        .update(gameServers)
        .set({
          currentState: previousState.currentState,
          desiredState: previousState.desiredState,
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));
    } catch (updateErr) {
      console.error(`[${serverId}] Failed to roll back to previous state:`, updateErr);
    }
  }

  private static async rollbackToStopped(serverId: string) {
    try {
      await db
        .update(gameServers)
        .set({
          currentState: "stopped",
          desiredState: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));
    } catch (updateErr) {
      console.error(`[${serverId}] Failed to roll back to stopped:`, updateErr);
    }
  }
  private static async patchDeploymentResources(
    deploymentName: string,
    namespace: string,
    cpuCores: string,
    ramMb: number,
    assertLeaseHeld: ServerBackupLeaseFence,
  ) {
    const appsApi = getAppsApi();
    const containerMemory = calculateContainerMemory(ramMb);
    const quantities = { cpu: cpuCores, memory: `${containerMemory}Mi` };
    await assertLeaseHeld();
    return appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [
        {
          op: "replace",
          path: "/spec/template/spec/containers/0/resources",
          value: { requests: quantities, limits: quantities },
        },
      ],
      fieldManager: "farlands-backend",
    });
  }
  private static async patchConfigMap(
    configMapName: string,
    namespace: string,
    gameConfigJson: NonNullable<UpdateServerConfigInput["gameConfigJson"]>,
    assertLeaseHeld: ServerBackupLeaseFence,
  ) {
    const coreApi = makeKubernetesClients().core;
    const data: Record<string, string> = {};

    if (gameConfigJson.maxPlayers !== undefined)
      data.MAX_PLAYERS = String(gameConfigJson.maxPlayers);
    if (gameConfigJson.difficulty !== undefined) data.DIFFICULTY = gameConfigJson.difficulty;
    if (gameConfigJson.pvp !== undefined) data.PVP = String(gameConfigJson.pvp);
    if (gameConfigJson.motd !== undefined) data.MOTD = gameConfigJson.motd;
    if (gameConfigJson.seed !== undefined) data.SEED = gameConfigJson.seed;

    const patches = Object.entries(data).map(([key, value]) => ({
      op: "add",
      path: `/data/${key}`,
      value,
    }));

    await assertLeaseHeld();
    return coreApi.patchNamespacedConfigMap({
      name: configMapName,
      namespace,
      body: patches,
      fieldManager: "farlands-backend",
    });
  }

  private static async resolveDeploymentConfigMap(
    deploymentName: string,
    namespace: string,
  ): Promise<string> {
    const deployment = await getAppsApi().readNamespacedDeployment({
      name: deploymentName,
      namespace,
    });
    const gameContainer = deployment.spec?.template.spec?.containers.find(
      (container) => container.name === "game-server",
    );
    const configMapName = gameContainer?.envFrom
      ?.map((source) => source.configMapRef?.name)
      .find((name): name is string => Boolean(name));
    if (!configMapName) {
      throw new Error(
        `Active Deployment '${namespace}/${deploymentName}' has no game-server ConfigMap`,
      );
    }
    return configMapName;
  }

  static async updateServerConfig(serverId: string, userId: string, data: UpdateServerConfigInput) {
    await this.requireOwnership(userId, serverId);
    const initialK8sRecord = await this.getK8sRecord(serverId);
    return withServerBackupLease(
      initialK8sRecord.namespace,
      serverId,
      "server-config",
      async (assertLeaseHeld) => {
        // A start or stop may have completed while this request waited for the
        // Lease, and a cutover may have promoted a new Deployment. Resolve both
        // desired state and Kubernetes target only after serialization.
        const leasedServer = await this.requireOwnership(userId, serverId);
        const k8sRecord = await this.getK8sRecord(serverId);
        if (k8sRecord.namespace !== initialK8sRecord.namespace) {
          throw status(409, "The server Kubernetes target changed; retry the configuration update");
        }
        const configMapName =
          data.gameConfigJson === undefined
            ? null
            : await this.resolveDeploymentConfigMap(k8sRecord.deploymentName, k8sRecord.namespace);
        await assertLeaseHeld();
        const persistedAt = new Date();
        const { previousConfig, newCpuCores, newRamMb } = await db.transaction(async (tx) => {
          // Every allocation mutation for an owner takes the same quota-row lock,
          // so two concurrent workload expansions cannot both admit against the
          // same stale aggregate.
          const quota = await QuotaService.getResourceLimits(userId, tx);
          if (!quota) throw status(404, "No quota found for this account.");

          const [previousConfig] = await tx
            .select()
            .from(serverConfigs)
            .where(eq(serverConfigs.serverId, serverId))
            .for("update");
          if (!previousConfig) throw status(404, "Server configuration not found");

          const newCpuCores = data.cpuCores ?? Number(previousConfig.cpuCores);
          const newRamMb = data.ramMb ?? previousConfig.ramMb;
          const newStorageGb = data.storageGb ?? previousConfig.storageGb;

          // Storage can be increased but not shrunk — PVCs are immutable in that direction.
          if (newStorageGb < previousConfig.storageGb) {
            throw status(
              400,
              `Storage cannot be reduced. Current size is ${previousConfig.storageGb}GB.`,
            );
          }
          if (newStorageGb > previousConfig.storageGb) {
            throw status(400, "Storage increases are not yet supported.");
          }

          const expandsAllocation =
            newCpuCores > Number(previousConfig.cpuCores) ||
            newRamMb > previousConfig.ramMb ||
            newStorageGb > previousConfig.storageGb;
          if (expandsAllocation) {
            assertAllocationFits(quota.limits, {
              servers: quota.used.servers,
              cpu: quota.used.cpu - Number(previousConfig.cpuCores) + newCpuCores,
              ramMb: quota.used.ramMb - previousConfig.ramMb + newRamMb,
              storageGb: quota.used.storageGb - previousConfig.storageGb + newStorageGb,
            });
          }

          await tx
            .update(serverConfigs)
            .set({
              cpuCores: String(newCpuCores),
              ramMb: newRamMb,
              storageGb: newStorageGb,
              gameConfigJson: data.gameConfigJson
                ? {
                    ...(previousConfig.gameConfigJson as Record<string, unknown>),
                    ...data.gameConfigJson,
                  }
                : previousConfig.gameConfigJson,
              updatedAt: persistedAt,
            })
            .where(eq(serverConfigs.serverId, serverId));

          return { previousConfig, newCpuCores, newRamMb, newStorageGb };
        });

        // Apply to K8s. If anything fails, revert the DB write above.
        try {
          if (data.cpuCores !== undefined || data.ramMb !== undefined) {
            await this.patchDeploymentResources(
              k8sRecord.deploymentName,
              k8sRecord.namespace,
              String(newCpuCores),
              newRamMb,
              assertLeaseHeld,
            );
          }

          if (data.gameConfigJson !== undefined) {
            await this.patchConfigMap(
              configMapName!,
              k8sRecord.namespace,
              data.gameConfigJson,
              assertLeaseHeld,
            );
          }

          // Recreate workloads have a real down/up gap. Keep the server Lease
          // until the controller observes this generation and the desired pod is
          // ready, so a weekly worker cannot raw-mount the PVC mid-restart.
          await this.triggerRollingRestart(
            k8sRecord.deploymentName,
            k8sRecord.namespace,
            leasedServer.desiredState === "running" ? 1 : 0,
            assertLeaseHeld,
          );

          return { success: true, message: "Server configuration updated" };
        } catch (error) {
          console.error(`[${serverId}] K8s config patch failed, reverting server_configs:`, error);

          // Revert DB to the snapshot taken before the update.
          const reverted = await db
            .update(serverConfigs)
            .set({
              cpuCores: previousConfig.cpuCores,
              ramMb: previousConfig.ramMb,
              storageGb: previousConfig.storageGb,
              gameConfigJson: previousConfig.gameConfigJson,
              updatedAt: new Date(),
            })
            .where(
              and(eq(serverConfigs.serverId, serverId), eq(serverConfigs.updatedAt, persistedAt)),
            )
            .returning({ id: serverConfigs.id });
          if (!reverted.length) {
            console.error(
              `[${serverId}] Config rollback skipped because a newer database revision exists`,
            );
          }

          throw status(500, "Failed to apply configuration change to server.");
        }
      },
    );
  }

  private static publicReceipt(row: typeof operatorReceipts.$inferSelect, reused: boolean) {
    return {
      receiptId: row.id,
      requestKey: row.requestKey,
      action: row.action,
      status: row.status,
      observedState: row.observedState,
      acceptedAt: row.acceptedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      reused,
    };
  }

  static async performAction(serverId: string, userId: string, data: ServerActionInput) {
    const { action, requestKey = `legacy:${crypto.randomUUID()}` } = serverActionDto.parse(data);
    await this.requireOwnership(userId, serverId);
    const id = `orc_${crypto.randomUUID().replaceAll("-", "")}`;
    const reservation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`operator:${userId}:${requestKey}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(operatorReceipts)
        .where(
          and(eq(operatorReceipts.userId, userId), eq(operatorReceipts.requestKey, requestKey)),
        );
      const disposition = operatorReceiptDisposition(existing ?? null, serverId, action);
      if (disposition === "conflict") {
        throw status(409, "That request key is already bound to another operation");
      }
      if (existing && disposition === "reuse") {
        return { receipt: existing, shouldExecute: false, reused: true };
      }
      if (existing && disposition === "retry") {
        const acceptedAt = new Date();
        const previousAttempt =
          typeof existing.detail.attempt === "number" ? existing.detail.attempt : 1;
        const attempt = previousAttempt + 1;
        const [retried] = await tx
          .update(operatorReceipts)
          .set({
            status: "accepted",
            observedState: null,
            detail: { ...existing.detail, attempt, retried_from: existing.status },
            acceptedAt,
            completedAt: null,
            updatedAt: acceptedAt,
          })
          .where(eq(operatorReceipts.id, existing.id))
          .returning();
        if (!retried) throw status(500, "Could not retry the operation receipt");
        await tx.insert(controlPlaneEvents).values({
          serverId,
          type: "operator_action",
          data: { receipt_id: existing.id, action, status: "accepted", attempt, retry: true },
        });
        return { receipt: retried, shouldExecute: true, reused: true };
      }

      const [created] = await tx
        .insert(operatorReceipts)
        .values({
          id,
          userId,
          serverId,
          requestKey,
          action,
          status: "accepted",
          detail: { attempt: 1 },
        })
        .returning();
      if (!created) throw status(500, "Could not create an operation receipt");
      await tx.insert(controlPlaneEvents).values({
        serverId,
        type: "operator_action",
        data: { receipt_id: id, action, status: "accepted", attempt: 1 },
      });
      return { receipt: created, shouldExecute: true, reused: false };
    });
    const receipt = reservation.receipt;
    const attempt = typeof receipt.detail.attempt === "number" ? receipt.detail.attempt : 1;
    if (!reservation.shouldExecute) {
      return {
        success: receipt.status === "completed",
        action,
        status: receipt.observedState ?? receipt.status,
        receipt: this.publicReceipt(receipt, true),
      };
    }

    try {
      const result = await this.performActionOnce(serverId, userId, { action });
      const completedAt = new Date();
      const [completed] = await db.transaction(async (tx) => {
        const rows = await tx
          .update(operatorReceipts)
          .set({
            status: "completed",
            observedState: result.status,
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(operatorReceipts.id, receipt.id))
          .returning();
        await tx.insert(controlPlaneEvents).values({
          serverId,
          type: "operator_action",
          data: {
            receipt_id: receipt.id,
            action,
            status: "completed",
            observed_state: result.status,
            attempt,
          },
        });
        return rows;
      });
      return { ...result, receipt: this.publicReceipt(completed!, reservation.reused) };
    } catch (error) {
      const failedAt = new Date();
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code: unknown }).code)
          : 500;
      const receiptStatus = code >= 400 && code < 500 ? "refused" : "failed";
      await db.transaction(async (tx) => {
        await tx
          .update(operatorReceipts)
          .set({ status: receiptStatus, completedAt: failedAt, updatedAt: failedAt })
          .where(eq(operatorReceipts.id, receipt.id));
        await tx.insert(controlPlaneEvents).values({
          serverId,
          type: "operator_action",
          data: { receipt_id: receipt.id, action, status: receiptStatus, attempt },
        });
      });
      throw error;
    }
  }

  private static async performActionOnce(
    serverId: string,
    userId: string,
    data: Pick<ServerActionInput, "action">,
  ) {
    const { action } = data;
    let previousState = await this.requireOwnership(userId, serverId);

    if (
      previousState.currentState === "restarting" &&
      previousState.desiredState === "stopped" &&
      (previousState.statusMessage === "Restoring backup" ||
        backupRestoreRecoveryRequired(previousState.statusMessage))
    ) {
      // A backend restart can interrupt the in-process restore monitor after
      // Kubernetes has already finished. Recover that durable Job state before
      // deciding whether a new power action is valid.
      const { BackupService } = await import("../backup/service");
      await BackupService.reconcileServerOperations(serverId);
      previousState = await this.requireOwnership(userId, serverId);
    }

    if (action === "start" && backupRestoreRecoveryRequired(previousState.statusMessage)) {
      throw status(409, BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE);
    }

    const initialK8sRecord = await this.getK8sRecord(serverId);
    return withServerBackupLease(
      initialK8sRecord.namespace,
      serverId,
      `server-action:${action}`,
      async (assertLeaseHeld) => {
        // The preflight above can become stale while this request waits for a
        // restore or cutover Lease. Re-read state and the active Deployment under
        // the Lease so a queued request cannot operate on retained server A.
        previousState = await this.requireOwnership(userId, serverId);
        const k8sRecord = await this.getK8sRecord(serverId);
        if (k8sRecord.namespace !== initialK8sRecord.namespace) {
          throw status(409, "The server Kubernetes target changed; retry the power action");
        }
        const { deploymentName, namespace } = k8sRecord;
        if (action === "start" && backupRestoreRecoveryRequired(previousState.statusMessage)) {
          throw status(409, BACKUP_RESTORE_RECOVERY_REQUIRED_MESSAGE);
        }
        await assertLeaseHeld();
        await this.claimTransition(userId, serverId, action);
        const appsApi = getAppsApi();

        if (action === "restart") {
          let scaledDown = false;
          try {
            await this.setReplicas(appsApi, deploymentName, namespace, 0, assertLeaseHeld);
            scaledDown = true;

            await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 0);

            await this.setReplicas(appsApi, deploymentName, namespace, 1, assertLeaseHeld);
            await assertLeaseHeld();
            await db
              .update(gameServers)
              .set({ currentState: "starting", updatedAt: new Date() })
              .where(eq(gameServers.id, serverId));

            await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 1);
            await assertLeaseHeld();
            await this.settleState(serverId, "running", "running");

            return { success: true, action, status: "running" };
          } catch (err) {
            console.error(`[${serverId}] Failed to perform ${action}:`, err);

            if (!scaledDown) {
              await assertLeaseHeld();
              await this.rollbackToPreviousState(serverId, previousState);
              throw status(500, `Failed to ${action} server`);
            }

            let compensated = false;
            try {
              await this.setReplicas(appsApi, deploymentName, namespace, 0, assertLeaseHeld);
              await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 0);
              compensated = true;
            } catch (compensateErr) {
              console.error(
                `[${serverId}] Failed to compensate with scale-down after restart error:`,
                compensateErr,
              );
            }
            if (compensated) {
              await assertLeaseHeld();
              await this.rollbackToStopped(serverId);
            } else {
              await assertLeaseHeld();
              await db
                .update(gameServers)
                .set({
                  currentState: "failed",
                  desiredState: "stopped",
                  statusMessage: "Restart failed and the workload could not be confirmed stopped",
                  updatedAt: new Date(),
                })
                .where(eq(gameServers.id, serverId));
            }
            throw status(500, `Failed to ${action} server`);
          }
        }

        // start / stop
        const replicas = REPLICA_TARGET[action];
        const finalState = action === "start" ? "running" : "stopped";

        try {
          await this.setReplicas(appsApi, deploymentName, namespace, replicas, assertLeaseHeld);
          await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, replicas);
          await assertLeaseHeld();
          await this.settleState(serverId, finalState, finalState);

          return { success: true, action, status: finalState };
        } catch (err) {
          console.error(`[${serverId}] Failed to perform ${action}:`, err);

          if (action === "start") {
            try {
              await this.setReplicas(appsApi, deploymentName, namespace, 0, assertLeaseHeld);
              await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 0);
              await assertLeaseHeld();
              await this.settleState(serverId, "stopped", "stopped");
            } catch (compensateErr) {
              console.error(
                `[${serverId}] Failed to compensate with scale-down after start error:`,
                compensateErr,
              );
              await assertLeaseHeld();
              await db
                .update(gameServers)
                .set({
                  currentState: "failed",
                  desiredState: "stopped",
                  statusMessage: "Start failed and the workload could not be confirmed stopped",
                  updatedAt: new Date(),
                })
                .where(eq(gameServers.id, serverId));
            }
            throw status(500, `Failed to ${action} server`);
          }

          try {
            const deployment = await appsApi.readNamespacedDeployment({
              name: deploymentName,
              namespace,
            });
            const liveReplicas = deployment.status?.readyReplicas ?? 0;
            const liveState = liveReplicas > 0 ? "running" : "stopped";
            await assertLeaseHeld();
            await this.settleState(serverId, liveState, liveState);
          } catch (reconcileErr) {
            console.error(
              `[${serverId}] Failed to reconcile live K8s state after ${action} error:`,
              reconcileErr,
            );
            await assertLeaseHeld();
            await this.rollbackToPreviousState(serverId, previousState);
          }

          throw status(500, `Failed to ${action} server`);
        }
      },
    );
  }

  static async getStatus(serverId: string, userId: string) {
    const server = await this.requireOwnership(userId, serverId);
    const k8sRecord = await this.getK8sRecord(serverId);

    let liveReplicas: number | null = null;
    try {
      const appsApi = getAppsApi();
      const deployment = await appsApi.readNamespacedDeployment({
        name: k8sRecord.deploymentName,
        namespace: k8sRecord.namespace,
      });
      liveReplicas = deployment.status?.readyReplicas ?? 0;
    } catch (err) {
      console.error(`[${serverId}] Failed to read live deployment status:`, err);
    }

    return {
      currentState: server.currentState,
      desiredState: server.desiredState,
      deploymentName: k8sRecord.deploymentName,
      namespace: k8sRecord.namespace,
      liveReplicas,
    };
  }

  static async create(userId: string, data: CreateServerInput) {
    const serverId = crypto.randomUUID();
    const routeHostname = getMinecraftRouteHostname(serverId);
    try {
      await db.transaction(async (tx: TransactionType) => {
        const quota = await QuotaService.getResourceLimits(userId, tx);
        if (!quota) {
          throw status(404, "No quota found for this account.");
        }

        assertAllocationFits(quota.limits, {
          servers: quota.used.servers + 1,
          cpu: quota.used.cpu + data.cpuCores,
          ramMb: quota.used.ramMb + data.ramMb,
          storageGb: quota.used.storageGb + data.storageGb,
        });

        await tx.insert(gameServers).values({
          id: serverId,
          userId: userId,
          name: data.name,
          game: data.game,
          currentState: "provisioning",
          desiredState: "ready",
        });

        await tx.insert(serverConfigs).values({
          id: crypto.randomUUID(),
          serverId: serverId,
          version: data.version,
          type: data.type,
          gameConfigJson: data.gameConfigJson,
          cpuCores: String(data.cpuCores),
          ramMb: data.ramMb,
          storageGb: data.storageGb,
          storageClass: "farlands-gp3",
        });

        await tx.insert(serverRoutes).values({
          id: crypto.randomUUID(),
          serverId: serverId,
          hostname: routeHostname,
          proxyTarget: null,
          ip: null,
          port: 25565,
        });

        //TODO: Log server creation
        console.info(`[${serverId}] Initial database records created for new game server`);
      });
    } catch (error) {
      if (isActiveNameConflict(error)) {
        throw status(409, `A server named "${data.name}" already exists.`);
      }
      throw error;
    }

    try {
      //TODO: send config data to provision service
      const isProvisioned = await provisionGameServer(serverId);

      if (!isProvisioned) {
        throw status(500, "Kubernetes provisioning failed or was rolled back.");
      }

      console.info(`[${serverId}] Server successfully provisioned on EKS`);
      return serverId;
    } catch (error) {
      console.error(`[${serverId}] Failed to provision server:`, error);
      // Failed server should be available for retry or must be deleted.
      await db
        .update(gameServers)
        .set({ currentState: "failed" })
        .where(eq(gameServers.id, serverId));
      throw error;
    }
  }

  static async delete(userId: string, serverId: string) {
    await this.requireOwnership(userId, serverId);
    const k8sRecord = await db.query.serverK8s.findFirst({
      where: eq(serverK8s.serverId, serverId),
    });
    const runDelete = async (assertLeaseHeld: ServerBackupLeaseFence) => {
      if (k8sRecord) {
        const leasedK8sRecord = await this.getK8sRecord(serverId);
        if (leasedK8sRecord.namespace !== k8sRecord.namespace) {
          throw status(409, "The server Kubernetes target changed; retry deletion");
        }
      }
      let previousState: StateType;
      let previousDesiredState: DesiredStateType;
      let previousStatusMessage: string | null;
      await assertLeaseHeld();
      await db.transaction(async (tx: TransactionType) => {
        const [server] = await tx
          .select({
            id: gameServers.id,
            currentState: gameServers.currentState,
            desiredState: gameServers.desiredState,
            statusMessage: gameServers.statusMessage,
          })
          .from(gameServers)
          .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)))
          .for("update");

        if (!server) throw status(404, "Server not found");

        if (
          server.currentState === "deleted" ||
          server.currentState === "provisioning" ||
          (server.currentState === "restarting" &&
            (server.statusMessage === "Restoring backup" ||
              backupRestoreRecoveryRequired(server.statusMessage)))
        ) {
          throw status(409, `Cannot delete server in state: ${server.currentState}`);
        }
        previousState = server.currentState;
        previousDesiredState = server.desiredState;
        previousStatusMessage = server.statusMessage;
        // TODO: create a current state named "deleting"
        // Setting the current state to deleted early for now.
        await tx
          .update(gameServers)
          .set({
            currentState: "deleted",
            desiredState: "deleted",
            updatedAt: new Date(),
          })
          .where(eq(gameServers.id, serverId));
      });

      try {
        console.info(`[${serverId}] Initiating Kubernetes teardown...`);

        await assertLeaseHeld();
        const k8sCleaned = await deleteGameServer(serverId, assertLeaseHeld);

        if (!k8sCleaned) {
          throw new Error("One or more Kubernetes resources failed to delete.");
        }
        await assertLeaseHeld();
        await db
          .update(gameServers)
          .set({
            currentState: "deleted",
            updatedAt: new Date(),
          })
          .where(eq(gameServers.id, serverId));

        console.info(`[${serverId}] Server fully deleted from system`);
        return { deletedServerId: serverId };
      } catch (error) {
        console.error(`[${serverId}] Deletion process failed:`, error);

        await restoreServerAfterFailedDeletion(
          serverId,
          previousState!,
          previousDesiredState!,
          previousStatusMessage!,
        );

        throw status(500, "Failed to fully delete server resources.");
      }
    };

    return k8sRecord
      ? withServerBackupLease(k8sRecord.namespace, serverId, "server-delete", runDelete)
      : runDelete(async () => {
          await assertNoActiveServerBackup(serverId);
          await assertNoPendingServerCutover(serverId);
        });
  }
}
