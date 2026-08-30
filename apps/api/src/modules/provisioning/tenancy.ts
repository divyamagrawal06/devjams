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

export function buildWorldSyncScripts(): { sender: string; receiver: string } {
  const sender = `#!/usr/bin/env python3
import datetime, http.server, io, json, os, stat, sys, tarfile, urllib.parse
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.path.realpath(os.environ.get("WORLD_ROOT", "/data"))

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

def parse_since(value):
    if not value:
        raise ValueError("delta requires since")
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("since must include a timezone")
    return parsed.timestamp()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\\n" % (self.address_string(), fmt % args))
    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/health":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/stream":
            self.send_response(404); self.end_headers(); return
        try:
            query = urllib.parse.parse_qs(parsed.query, strict_parsing=True) if parsed.query else {}
            if set(query) - {"delta", "since"}:
                raise ValueError("unsupported query parameter")
            delta = query.get("delta", []) == ["1"]
            if query.get("delta", []) not in ([], ["1"]):
                raise ValueError("delta must equal 1")
            since_timestamp = parse_since(query.get("since", [None])[0]) if delta else None
        except (ValueError, TypeError) as error:
            self.send_response(400); self.end_headers(); self.wfile.write(str(error).encode()); return

        entries = source_manifest()
        manifest = json.dumps(entries, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-tar")
        self.end_headers()
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
                if delta and not stat.S_ISDIR(metadata.st_mode) and metadata.st_mtime <= since_timestamp:
                    continue
                archive.add(full_path, arcname=relative, recursive=False)

http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;

  const receiver = `#!/usr/bin/env python3
import json, os, posixpath, sys, tarfile, urllib.parse, urllib.request
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.path.realpath(os.environ.get("WORLD_ROOT", "/data"))
SOURCE = os.environ["SOURCE_SYNC_URL"]
PHASE = os.environ.get("WORLD_SYNC_PHASE", "presync")
SINCE = os.environ.get("WORLD_SYNC_SINCE")
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

def mark_complete():
    if PHASE == "presync" and MARKER:
        with open(MARKER, "w", encoding="utf-8") as handle:
            handle.write("complete\\n")

if PHASE == "presync" and MARKER and os.path.isfile(MARKER):
    sys.exit(0)

parsed = urllib.parse.urlparse(SOURCE)
if parsed.scheme != "http" or parsed.port != PORT or parsed.path != "/stream":
    raise ValueError("SOURCE_SYNC_URL must name the tenant world-sync service")
if not parsed.hostname or not parsed.hostname.endswith(".svc.cluster.local"):
    raise ValueError("SOURCE_SYNC_URL must stay inside cluster DNS")
if PHASE not in ("presync", "delta"):
    raise ValueError("WORLD_SYNC_PHASE must be presync or delta")
if PHASE == "delta" and not SINCE:
    raise ValueError("WORLD_SYNC_SINCE is required for delta sync")
query = "?" + urllib.parse.urlencode({"delta": "1", "since": SINCE}) if PHASE == "delta" else ""
request = urllib.request.Request(SOURCE + query, data=b"", method="POST")
os.makedirs(ROOT, exist_ok=True)
with urllib.request.urlopen(request, timeout=900) as response:
    if response.status == 204:
        prune(set()); mark_complete(); sys.exit(0)
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
mark_complete()
`;

  return { sender, receiver };
}

async function ensureWorldSyncConfigMap(core: k8s.CoreV1Api, namespace: string): Promise<void> {
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
    await core.replaceNamespacedConfigMap({
      name: "cm-world-sync",
      namespace,
      body,
    });
  }
}

export async function ensureTenantNamespace(
  userId: string,
  clients: KubernetesClients = makeKubernetesClients(),
): Promise<string> {
  const namespace = tenantNamespace(userId);
  const quota = await quotaMirrorForUser(userId);

  await ensureNamespace(clients.core, namespace, userId);
  await upsertQuota(clients.core, namespace, quota);
  await ensureLimitRange(clients.core, namespace);
  await ensureDefaultDeny(clients.networking, namespace);
  await ensureRconSecret(clients.core, namespace);
  await copyVelocitySecret(clients.core, namespace);
  await ensureWorldSyncConfigMap(clients.core, namespace);

  return namespace;
}
