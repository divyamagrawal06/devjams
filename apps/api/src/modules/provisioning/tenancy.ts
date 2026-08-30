import { randomBytes } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { userQuotas } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  getKubernetesStatusCode,
  type KubernetesClients,
  makeKubernetesClients,
} from "./kubernetes";

export const SYSTEM_NAMESPACE = process.env.FARLANDS_SYSTEM_NAMESPACE ?? "farlands-system";
export const PROXY_NAMESPACE = process.env.FARLANDS_PROXY_NAMESPACE ?? "infra-team";
export const BACKEND_NAMESPACE = process.env.FARLANDS_BACKEND_NAMESPACE ?? "dev-deployment";
export const RCON_SECRET_NAME = "rcon-password";
export const RCON_SECRET_KEY = "password";
export const RCON_PASSWORD_MOUNT = "/run/secrets/rcon";
export const RCON_PASSWORD_FILE = `${RCON_PASSWORD_MOUNT}/${RCON_SECRET_KEY}`;
export const WORLD_SYNC_PORT = 8080;
export const WORLD_SYNC_ROOT = "/data";
export const WORLD_SYNC_NAMES = "world,world_nether,world_the_end";
export const RCON_PORT = 25575;
export const VELOCITY_SECRET_NAME =
  process.env.FARLANDS_VELOCITY_SECRET_NAME ?? "velocity-forwarding-secret";
const DEFAULT_ARTIFACT_SERVICE_ACCOUNT = "farlands-artifact-reader";

export function artifactServiceAccountName(
  configured = process.env.FARLANDS_ARTIFACT_SERVICE_ACCOUNT,
): string {
  const name = configured?.trim() || DEFAULT_ARTIFACT_SERVICE_ACCOUNT;
  if (name.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new Error("FARLANDS_ARTIFACT_SERVICE_ACCOUNT must be a DNS-1123 service account name");
  }
  return name;
}

export function buildArtifactServiceAccount(
  namespace: string,
  name = artifactServiceAccountName(),
  roleArn = process.env.FARLANDS_ARTIFACT_ROLE_ARN?.trim(),
): k8s.V1ServiceAccount {
  return {
    metadata: {
      name,
      namespace,
      labels: { "farlands.dev/kind": "rule-artifact-reader" },
      ...(roleArn ? { annotations: { "eks.amazonaws.com/role-arn": roleArn } } : {}),
    },
    automountServiceAccountToken: false,
  };
}
export const BACKUP_WORKER_ROLE_ANNOTATION = "eks.amazonaws.com/role-arn";
export const DEFAULT_BACKUP_WORKER_SERVICE_ACCOUNT = "backup-orchestrator";
export const BACKUP_TENANT_WORKER_CLUSTER_ROLE = "farlands-backup-tenant-worker";
export const BACKUP_ORCHESTRATOR_ROLE_BINDING = "farlands-backup-orchestrator";

export type TenantQuotaMirror = {
  cpuLimit: string;
  ramLimitMb: number;
  storageLimitGb: number;
  serversLimit: number;
};

const DEFAULT_QUOTA: TenantQuotaMirror = {
  cpuLimit: "2",
  ramLimitMb: 2048,
  storageLimitGb: 5,
  serversLimit: 1,
};

export function tenantNamespace(userId: string): string {
  const slug = userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw new Error("userId cannot be mapped to a Kubernetes namespace");
  }
  return `fl-${slug}`;
}

export async function quotaMirrorForUser(userId: string): Promise<TenantQuotaMirror> {
  const [row] = await db
    .select({
      cpuLimit: userQuotas.cpuLimit,
      ramLimitMb: userQuotas.ramLimitMb,
      storageLimitGb: userQuotas.storageLimitGb,
      serversLimit: userQuotas.serversLimit,
    })
    .from(userQuotas)
    .where(eq(userQuotas.userId, userId))
    .limit(1);

  return row ?? DEFAULT_QUOTA;
}

function alreadyExists(error: unknown): boolean {
  return getKubernetesStatusCode(error) === 409;
}

function notFound(error: unknown): boolean {
  return getKubernetesStatusCode(error) === 404;
}

export type BackupWorkerIdentityConfig = {
  roleArn: string;
  serviceAccount: string;
};

const IAM_ROLE_ARN = /^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;

export function resolveBackupWorkerIdentityConfig(
  environment: Record<string, string | undefined> = process.env,
): BackupWorkerIdentityConfig {
  const roleArn = environment.FARLANDS_BACKUP_WORKER_ROLE_ARN?.trim();
  if (!roleArn) {
    throw new Error(
      "Minecraft provisioning is disabled until FARLANDS_BACKUP_WORKER_ROLE_ARN is configured; a realm cannot be created without weekly backup credentials",
    );
  }
  if (roleArn.length > 512 || !IAM_ROLE_ARN.test(roleArn)) {
    throw new Error("FARLANDS_BACKUP_WORKER_ROLE_ARN must be a valid IAM role ARN");
  }

  const serviceAccount =
    environment.FARLANDS_BACKUP_WORKER_SERVICE_ACCOUNT?.trim() ||
    DEFAULT_BACKUP_WORKER_SERVICE_ACCOUNT;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceAccount) || serviceAccount.length > 63) {
    throw new Error(
      "FARLANDS_BACKUP_WORKER_SERVICE_ACCOUNT must be a valid Kubernetes ServiceAccount name",
    );
  }

  return { roleArn, serviceAccount };
}

export function buildBackupWorkerServiceAccount(
  namespace: string,
  config: BackupWorkerIdentityConfig,
): k8s.V1ServiceAccount {
  return {
    metadata: {
      name: config.serviceAccount,
      namespace,
      labels: {
        "app.kubernetes.io/name": "server-backup-worker",
        "app.kubernetes.io/part-of": "farlands",
        "app.kubernetes.io/component": "backup",
      },
      annotations: { [BACKUP_WORKER_ROLE_ANNOTATION]: config.roleArn },
    },
    automountServiceAccountToken: false,
  };
}

export function buildBackupOrchestratorRoleBinding(
  namespace: string,
  environment: Record<string, string | undefined> = process.env,
): k8s.V1RoleBinding {
  const orchestratorNamespace =
    environment.BACKUP_NAMESPACE?.trim() ||
    environment.FARLANDS_PROXY_NAMESPACE?.trim() ||
    PROXY_NAMESPACE;
  const orchestratorServiceAccount =
    environment.BACKUP_ORCHESTRATOR_SERVICE_ACCOUNT?.trim() ||
    DEFAULT_BACKUP_WORKER_SERVICE_ACCOUNT;

  return {
    metadata: {
      name: BACKUP_ORCHESTRATOR_ROLE_BINDING,
      namespace,
      labels: {
        "app.kubernetes.io/name": "server-backup-orchestrator",
        "app.kubernetes.io/part-of": "farlands",
        "app.kubernetes.io/component": "backup",
      },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: BACKUP_TENANT_WORKER_CLUSTER_ROLE,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: orchestratorServiceAccount,
        namespace: orchestratorNamespace,
      },
    ],
  };
}

export async function ensureBackupOrchestratorAccess(
  rbac: k8s.RbacAuthorizationV1Api,
  namespace: string,
): Promise<void> {
  if (!namespace.startsWith("fl-")) {
    throw new Error(
      `Refusing to grant backup orchestrator access outside an fl-* namespace: ${namespace}`,
    );
  }

  const desired = buildBackupOrchestratorRoleBinding(namespace);
  try {
    await rbac.createNamespacedRoleBinding({ namespace, body: desired });
    return;
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }

  const existing = await rbac.readNamespacedRoleBinding({
    name: BACKUP_ORCHESTRATOR_ROLE_BINDING,
    namespace,
  });
  desired.metadata!.resourceVersion = existing.metadata?.resourceVersion;
  await rbac.replaceNamespacedRoleBinding({
    name: BACKUP_ORCHESTRATOR_ROLE_BINDING,
    namespace,
    body: desired,
  });
}

function assertBackupWorkerServiceAccount(
  serviceAccount: k8s.V1ServiceAccount,
  namespace: string,
  config: BackupWorkerIdentityConfig,
): void {
  const actualRole = serviceAccount.metadata?.annotations?.[BACKUP_WORKER_ROLE_ANNOTATION];
  if (actualRole !== config.roleArn || serviceAccount.automountServiceAccountToken !== false) {
    throw new Error(
      `Backup worker identity '${namespace}/${config.serviceAccount}' is not the managed IRSA identity; apply the backup Terraform stack before provisioning this realm`,
    );
  }
}

export async function ensureBackupWorkerIdentity(
  core: k8s.CoreV1Api,
  namespace: string,
  config: BackupWorkerIdentityConfig = resolveBackupWorkerIdentityConfig(),
): Promise<void> {
  if (!namespace.startsWith("fl-")) {
    throw new Error(
      `Refusing to create a tenant backup identity outside an fl-* namespace: ${namespace}`,
    );
  }

  try {
    const existing = await core.readNamespacedServiceAccount({
      name: config.serviceAccount,
      namespace,
    });
    assertBackupWorkerServiceAccount(existing, namespace, config);
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  try {
    await core.createNamespacedServiceAccount({
      namespace,
      body: buildBackupWorkerServiceAccount(namespace, config),
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;

    const existing = await core.readNamespacedServiceAccount({
      name: config.serviceAccount,
      namespace,
    });
    assertBackupWorkerServiceAccount(existing, namespace, config);
  }
}

async function ensureNamespace(
  core: k8s.CoreV1Api,
  namespace: string,
  userId: string,
): Promise<void> {
  try {
    await core.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: {
            "farlands.dev/tenant": "true",
            "farlands.dev/user-id": userId.slice(0, 63),
            "pod-security.kubernetes.io/enforce": "baseline",
          },
        },
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

function buildResourceQuota(namespace: string, quota: TenantQuotaMirror): k8s.V1ResourceQuota {
  // Double CPU/RAM/PVC so a candidate can exist during deploy (headroom).
  const cpu = `${Number.parseFloat(quota.cpuLimit) * 2}`;
  const memoryGi = Math.ceil((quota.ramLimitMb * 2 * 1.5) / 1024);
  const storage = quota.storageLimitGb * 2;
  const pods = Math.max(quota.serversLimit * 6, 8);

  return {
    metadata: { name: "tenant-quota", namespace },
    spec: {
      hard: {
        pods: String(pods),
        "requests.cpu": cpu,
        "limits.cpu": cpu,
        "requests.memory": `${memoryGi}Gi`,
        "limits.memory": `${memoryGi}Gi`,
        "requests.storage": `${storage}Gi`,
        persistentvolumeclaims: String(Math.max(quota.serversLimit * 3, 4)),
      },
    },
  };
}

function buildLimitRange(namespace: string): k8s.V1LimitRange {
  return {
    metadata: { name: "tenant-limits", namespace },
    spec: {
      limits: [
        {
          type: "Container",
          defaultRequest: { cpu: "250m", memory: "256Mi" },
          default: { cpu: "1", memory: "1280Mi" },
          max: { cpu: "2", memory: "4Gi" },
        } as k8s.V1LimitRangeItem,
        {
          type: "PersistentVolumeClaim",
          max: { storage: "20Gi" },
        },
      ],
    },
  };
}

function buildDefaultDeny(namespace: string): k8s.V1NetworkPolicy {
  return {
    metadata: { name: "default-deny-cross-tenant", namespace },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [
        { from: [{ podSelector: {} }] } as k8s.V1NetworkPolicyIngressRule,
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "farlands.dev/shared": "true" },
              },
            },
          ],
        } as k8s.V1NetworkPolicyIngressRule,
      ],
    },
  };
}

async function upsertQuota(
  core: k8s.CoreV1Api,
  namespace: string,
  quota: TenantQuotaMirror,
): Promise<void> {
  const body = buildResourceQuota(namespace, quota);
  try {
    await core.createNamespacedResourceQuota({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    await core.replaceNamespacedResourceQuota({
      name: "tenant-quota",
      namespace,
      body,
    });
  }
}

async function ensureLimitRange(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const body = buildLimitRange(namespace);
  try {
    await core.createNamespacedLimitRange({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error) && !notFound(error)) {
      // Some clusters reject LimitRange create as 409; ignore exists.
      if (getKubernetesStatusCode(error) !== 409) throw error;
    }
  }
}

async function ensureDefaultDeny(
  networking: k8s.NetworkingV1Api,
  namespace: string,
): Promise<void> {
  const body = buildDefaultDeny(namespace);
  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

async function ensureRconSecret(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  try {
    await core.readNamespacedSecret({ name: RCON_SECRET_NAME, namespace });
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  const password = randomBytes(24).toString("base64url");
  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: RCON_SECRET_NAME,
        namespace,
        labels: { "farlands.dev/kind": "rcon" },
      },
      type: "Opaque",
      stringData: { [RCON_SECRET_KEY]: password },
    },
  });
}

async function ensureArtifactServiceAccount(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const body = buildArtifactServiceAccount(namespace);
  const name = body.metadata?.name;
  if (!name) throw new Error("Artifact ServiceAccount name is unavailable");
  try {
    const existing = await core.readNamespacedServiceAccount({ name, namespace });
    const expectedRole = body.metadata?.annotations?.["eks.amazonaws.com/role-arn"];
    if (
      expectedRole &&
      existing.metadata?.annotations?.["eks.amazonaws.com/role-arn"] !== expectedRole
    ) {
      throw new Error(`Artifact ServiceAccount ${namespace}/${name} has the wrong IAM role`);
    }
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  try {
    await core.createNamespacedServiceAccount({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

async function copyVelocitySecret(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  try {
    await core.readNamespacedSecret({
      name: VELOCITY_SECRET_NAME,
      namespace,
    });
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  const source = await core.readNamespacedSecret({
    name: VELOCITY_SECRET_NAME,
    namespace: PROXY_NAMESPACE,
  });

  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: VELOCITY_SECRET_NAME,
        namespace,
        labels: { "farlands.dev/kind": "velocity-forwarding" },
      },
      type: "Opaque",
      data: source.data,
    },
  });
}

export function buildWorldSyncSenderScript(): string {
  return `#!/usr/bin/env python3
import http.server, io, json, os, socket, stat, struct, subprocess, sys, tarfile, threading, time, urllib.parse
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.path.realpath(os.environ.get("WORLD_ROOT", "/data"))
BACKUP_ROOT = os.path.realpath(os.environ.get("BACKUP_ROOT", "/data"))
RCON_HOST = os.environ.get("RCON_HOST", "127.0.0.1")
RCON_PORT = int(os.environ.get("RCON_PORT", "25575"))
RCON_PASSWORD_FILE = os.environ.get("RCON_PASSWORD_FILE", "/run/secrets/rcon/password")
BACKUP_LOCK = threading.Lock()

def managed_names():
    names = []
    for raw in os.environ.get("WORLD_NAMES", "world,world_nether,world_the_end").split(","):
        name = raw.strip()
        if not name or name in (".", "..") or os.path.basename(name) != name or "\\\\" in name:
            raise ValueError("WORLD_NAMES must contain simple directory names")
        if name not in names:
            names.append(name)
    if not names:
        raise ValueError("WORLD_NAMES cannot be empty")
    return tuple(names)

NAMES = managed_names()

def recv_exact(sock, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk: raise ConnectionError("RCON connection closed")
        chunks.append(chunk); remaining -= len(chunk)
    return b"".join(chunks)

def encode_packet(request_id, packet_type, body):
    payload = struct.pack("<ii", request_id, packet_type) + body.encode("utf-8") + b"\\x00\\x00"
    return struct.pack("<i", len(payload)) + payload

class Rcon:
    def __init__(self):
        with open(RCON_PASSWORD_FILE, "r", encoding="utf-8") as handle:
            password = handle.read().strip()
        self.sock = socket.create_connection((RCON_HOST, RCON_PORT), timeout=10)
        self.sock.settimeout(30)
        self.request_id = 1
        self.sock.sendall(encode_packet(self.request_id, 3, password))
        response_id, _ = self._read()
        if response_id == -1:
            self.close(); raise PermissionError("RCON authentication failed")
    def _read(self):
        size = struct.unpack("<i", recv_exact(self.sock, 4))[0]
        payload = recv_exact(self.sock, size)
        request_id, packet_type = struct.unpack("<ii", payload[:8])
        return request_id, payload[8:-2].decode("utf-8", errors="replace")
    def send(self, command):
        self.request_id += 1
        self.sock.sendall(encode_packet(self.request_id, 2, command))
        response_id, body = self._read()
        if response_id != self.request_id: raise RuntimeError("RCON response mismatch")
        return body
    def close(self):
        try: self.sock.close()
        except Exception: pass

def force_save_on():
    client = Rcon()
    try: client.send("save-on")
    finally: client.close()

def restore_saves(client, timeout_seconds=120):
    deadline = time.monotonic() + timeout_seconds
    last_error = None
    if client is not None:
        try:
            client.send("save-on"); return
        except Exception as error:
            last_error = error
    while time.monotonic() < deadline:
        try:
            force_save_on(); return
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError("save-on could not be restored before the deadline") from last_error

def recover_saves_on_startup():
    # A request may have disabled saves immediately before this container was
    # restarted. Keep retrying until Minecraft accepts save-on; otherwise a
    # long RCON outage could leave the live world unsaved indefinitely.
    while True:
        try:
            force_save_on(); return
        except Exception:
            time.sleep(1)

def source_manifest():
    paths = []
    for world in NAMES:
        base = os.path.join(ROOT, world)
        if not os.path.isdir(base) or os.path.islink(base):
            continue
        paths.append(world)
        for current, directories, files in os.walk(base, followlinks=False):
            directories[:] = sorted(
                name for name in directories if not os.path.islink(os.path.join(current, name))
            )
            files = sorted(
                name for name in files if not os.path.islink(os.path.join(current, name))
            )
            for name in directories + files:
                paths.append(os.path.relpath(os.path.join(current, name), ROOT))
    return paths

def parse_since_ns(value):
    if not value or not value.isascii() or not value.isdigit():
        raise ValueError("delta requires a source snapshot boundary")
    parsed = int(value)
    if parsed < 1:
        raise ValueError("source snapshot boundary must be positive")
    return parsed

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\\n" % (self.address_string(), fmt % args))
    def send_bytes(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/health":
            self.send_bytes(200, b"ok"); return
        self.send_bytes(404, b"not found")
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/backup":
            self.stream_consistent_backup(); return
        if parsed.path != "/stream":
            self.send_bytes(404, b"not found"); return
        try:
            query = urllib.parse.parse_qs(parsed.query, strict_parsing=True) if parsed.query else {}
            if set(query) - {"delta", "since_ns"}:
                raise ValueError("unsupported query parameter")
            delta = query.get("delta", []) == ["1"]
            if query.get("delta", []) not in ([], ["1"]):
                raise ValueError("delta must equal 1")
            since_ns = parse_since_ns(query.get("since_ns", [None])[0]) if delta else None
        except (ValueError, TypeError) as error:
            self.send_bytes(400, str(error).encode()); return

        snapshot_started_ns = time.time_ns()
        entries = source_manifest()
        manifest = json.dumps(entries, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-tar")
        self.send_header("X-Farlands-Snapshot-Started-Ns", str(snapshot_started_ns))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with tarfile.open(fileobj=self.wfile, mode="w|") as archive:
            info = tarfile.TarInfo(".farlands-source-manifest.json")
            info.size = len(manifest); info.mode = 0o600
            archive.addfile(info, io.BytesIO(manifest))
            for relative in entries:
                full_path = os.path.realpath(os.path.join(ROOT, relative))
                if os.path.commonpath((ROOT, full_path)) != ROOT:
                    raise RuntimeError("world path escaped the managed root")
                metadata = os.lstat(full_path)
                if stat.S_ISLNK(metadata.st_mode):
                    continue
                if delta and not stat.S_ISDIR(metadata.st_mode) and metadata.st_mtime_ns <= since_ns:
                    continue
                archive.add(full_path, arcname=relative, recursive=False)

    def stream_consistent_backup(self):
        if not BACKUP_LOCK.acquire(blocking=False):
            self.send_bytes(409, b"backup already active"); return
        client = None
        response_started = False
        archive_complete = False
        save_on_error = None
        try:
            if not os.path.isdir(BACKUP_ROOT): raise FileNotFoundError("backup root is missing")
            rollback_root = os.path.join(BACKUP_ROOT, ".farlands-restore-rollback")
            if os.path.isdir(rollback_root) and any(os.scandir(rollback_root)):
                raise RuntimeError("manual restore recovery data must be resolved before backup")
            client = Rcon()
            client.send("save-off")
            client.send("save-all flush")
            proc = subprocess.Popen(
                [
                    "tar", "-C", BACKUP_ROOT,
                    "--exclude=./.farlands-restore-staging",
                    "--exclude=./.farlands-restore-rollback",
                    "-czf", "-", "."
                ],
                stdout=subprocess.PIPE,
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers(); response_started = True
            assert proc.stdout is not None
            try:
                while True:
                    chunk = proc.stdout.read(1024 * 256)
                    if not chunk: break
                    self.wfile.write(("%X\\r\\n" % len(chunk)).encode("ascii"))
                    self.wfile.write(chunk); self.wfile.write(b"\\r\\n")
            finally:
                proc.stdout.close(); proc.wait()
            if proc.returncode != 0: raise RuntimeError("backup tar failed with exit %s" % proc.returncode)
            archive_complete = True
        except Exception as error:
            sys.stderr.write("consistent backup failed: %s\\n" % error)
            if not response_started:
                self.send_bytes(503, b"backup unavailable")
        finally:
            try:
                restore_saves(client)
            except Exception as error:
                save_on_error = error
                sys.stderr.write("failed to restore save-on: %s\\n" % error)
            if client is not None: client.close()
            BACKUP_LOCK.release()
        if response_started:
            if archive_complete and save_on_error is None:
                self.wfile.write(b"0\\r\\n\\r\\n"); self.wfile.flush()
            else:
                self.close_connection = True
        if save_on_error is not None:
            sys.stderr.write("restarting sidecar after save-on recovery failure\\n")
            os._exit(1)

# Do not accept backup or cutover streams until save-on is confirmed. Serving
# concurrently with startup recovery could re-enable saving during an archive.
recover_saves_on_startup()
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;
}

export function buildWorldSyncScripts(): { sender: string; receiver: string } {
  const sender = buildWorldSyncSenderScript();

  const receiver = `#!/usr/bin/env python3
import json, os, posixpath, sys, tarfile, urllib.parse, urllib.request
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.path.realpath(os.environ.get("WORLD_ROOT", "/data"))
SOURCE = os.environ["SOURCE_SYNC_URL"]
PHASE = os.environ.get("WORLD_SYNC_PHASE", "presync")
SINCE = os.environ.get("WORLD_SYNC_SINCE")
SINCE_FILE = os.environ.get("WORLD_SYNC_SINCE_FILE")
MARKER = os.environ.get("WORLD_SYNC_MARKER")
MANIFEST = ".farlands-source-manifest.json"

def managed_names():
    names = []
    for raw in os.environ.get("WORLD_NAMES", "world,world_nether,world_the_end").split(","):
        name = raw.strip()
        if not name or name in (".", "..") or os.path.basename(name) != name or "\\\\" in name:
            raise ValueError("WORLD_NAMES must contain simple directory names")
        if name not in names:
            names.append(name)
    if not names:
        raise ValueError("WORLD_NAMES cannot be empty")
    return tuple(names)

NAMES = managed_names()

def normalize_relative(value):
    if not isinstance(value, str) or not value or "\\\\" in value:
        raise RuntimeError("world-sync manifest contains an invalid path")
    normalized = posixpath.normpath(value)
    if normalized != value or normalized.startswith("/") or normalized in (".", ".."):
        raise RuntimeError("world-sync manifest contains a non-canonical path")
    return normalized

def is_managed(relative):
    return any(relative == name or relative.startswith(name + "/") for name in NAMES)

def extraction_filter(member, destination):
    filtered = tarfile.data_filter(member, destination)
    if filtered is None:
        return None
    relative = filtered.name[2:] if filtered.name.startswith("./") else filtered.name
    if relative == MANIFEST:
        if not filtered.isfile():
            raise tarfile.FilterError("world-sync manifest must be a regular file")
        return filtered
    relative = normalize_relative(relative)
    if not is_managed(relative) or filtered.issym() or filtered.islnk():
        raise tarfile.FilterError("archive member is outside managed world roots")
    if not filtered.isdir() and not filtered.isfile():
        raise tarfile.FilterError("archive member type is not allowed")
    return filtered

def prune(expected):
    for world in NAMES:
        base = os.path.join(ROOT, world)
        if not os.path.lexists(base):
            continue
        if os.path.islink(base):
            os.unlink(base); continue
        for current, directories, files in os.walk(base, topdown=False, followlinks=False):
            for name in files:
                path = os.path.join(current, name)
                relative = os.path.relpath(path, ROOT).replace(os.sep, "/")
                if relative not in expected:
                    os.unlink(path)
            for name in directories:
                path = os.path.join(current, name)
                relative = os.path.relpath(path, ROOT).replace(os.sep, "/")
                if os.path.islink(path):
                    if relative not in expected: os.unlink(path)
                elif relative not in expected and not os.listdir(path):
                    os.rmdir(path)
        if world not in expected and os.path.isdir(base) and not os.listdir(base):
            os.rmdir(base)

def source_boundary(response):
    value = response.headers.get("X-Farlands-Snapshot-Started-Ns", "")
    if not value.isascii() or not value.isdigit() or int(value) < 1:
        raise RuntimeError("world-sync sender omitted its source snapshot boundary")
    return value

def mark_complete(boundary):
    if PHASE == "presync" and MARKER:
        with open(MARKER, "w", encoding="utf-8") as handle:
            handle.write(boundary + "\\n")

if PHASE == "presync" and MARKER and os.path.isfile(MARKER):
    sys.exit(0)

parsed = urllib.parse.urlparse(SOURCE)
if parsed.scheme != "http" or parsed.port != PORT or parsed.path != "/stream":
    raise ValueError("SOURCE_SYNC_URL must name the tenant world-sync service")
if not parsed.hostname or not parsed.hostname.endswith(".svc.cluster.local"):
    raise ValueError("SOURCE_SYNC_URL must stay inside cluster DNS")
if PHASE not in ("presync", "delta"):
    raise ValueError("WORLD_SYNC_PHASE must be presync or delta")
if PHASE == "delta" and SINCE_FILE:
    with open(SINCE_FILE, "r", encoding="utf-8") as handle:
        SINCE = handle.read().strip()
if PHASE == "delta" and (not SINCE or not SINCE.isascii() or not SINCE.isdigit()):
    raise ValueError("delta sync requires a source-host snapshot boundary")
query = "?" + urllib.parse.urlencode({"delta": "1", "since_ns": SINCE}) if PHASE == "delta" else ""
request = urllib.request.Request(SOURCE + query, data=b"", method="POST")
os.makedirs(ROOT, exist_ok=True)
with urllib.request.urlopen(request, timeout=900) as response:
    boundary = source_boundary(response)
    if response.status == 204:
        prune(set()); mark_complete(boundary); sys.exit(0)
    if response.headers.get_content_type() != "application/x-tar":
        raise RuntimeError("world-sync sender returned an unexpected content type")
    with tarfile.open(fileobj=response, mode="r|") as archive:
        archive.extractall(path=ROOT, filter=extraction_filter)
manifest_path = os.path.join(ROOT, MANIFEST)
if not os.path.isfile(manifest_path):
    raise RuntimeError("world-sync response did not include the source manifest")
with open(manifest_path, "r", encoding="utf-8") as handle:
    raw_expected = json.load(handle)
if not isinstance(raw_expected, list):
    raise RuntimeError("world-sync manifest must be a list")
expected = {normalize_relative(value) for value in raw_expected}
if not all(is_managed(relative) for relative in expected):
    raise RuntimeError("world-sync manifest contains an unmanaged path")
prune(expected)
os.unlink(manifest_path)
mark_complete(boundary)
`;

  return { sender, receiver };
}

export async function ensureWorldSyncConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
): Promise<void> {
  const { sender, receiver } = buildWorldSyncScripts();

  const body: k8s.V1ConfigMap = {
    metadata: { name: "cm-world-sync", namespace },
    data: {
      "sender.py": sender,
      "receiver.py": receiver,
    },
  };

  try {
    await core.createNamespacedConfigMap({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await core.readNamespacedConfigMap({
      name: "cm-world-sync",
      namespace,
    });
    const desiredData = {
      ...existing.data,
      ...body.data,
    };
    if (
      existing.data?.["sender.py"] === desiredData["sender.py"] &&
      existing.data?.["receiver.py"] === desiredData["receiver.py"]
    ) {
      return;
    }
    await core.replaceNamespacedConfigMap({
      name: "cm-world-sync",
      namespace,
      body: {
        ...existing,
        data: desiredData,
      },
    });
  }
}

export async function ensureTenantNamespace(
  userId: string,
  clients: KubernetesClients = makeKubernetesClients(),
  assertMutationAllowed: () => Promise<void> = async () => {},
): Promise<string> {
  const namespace = tenantNamespace(userId);
  const quota = await quotaMirrorForUser(userId);

  await assertMutationAllowed();
  await ensureNamespace(clients.core, namespace, userId);
  await assertMutationAllowed();
  await ensureBackupWorkerIdentity(clients.core, namespace);
  await assertMutationAllowed();
  await ensureBackupOrchestratorAccess(clients.rbac, namespace);
  await assertMutationAllowed();
  await upsertQuota(clients.core, namespace, quota);
  await assertMutationAllowed();
  await ensureLimitRange(clients.core, namespace);
  await assertMutationAllowed();
  await ensureDefaultDeny(clients.networking, namespace);
  await assertMutationAllowed();
  await ensureArtifactServiceAccount(clients.core, namespace);
  await assertMutationAllowed();
  await ensureRconSecret(clients.core, namespace);
  await assertMutationAllowed();
  await copyVelocitySecret(clients.core, namespace);
  await assertMutationAllowed();
  await ensureWorldSyncConfigMap(clients.core, namespace);

  return namespace;
}

export const tenancyManifestTestUtils = {
  buildResourceQuota,
  buildLimitRange,
  buildBackupWorkerServiceAccount,
};
