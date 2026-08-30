export type LiveServer = {
  id: string;
  name: string;
  game: string;
  currentState: string;
  desiredState: string;
  statusMessage: string | null;
  version: string | null;
  type?: string | null;
  hostname: string | null;
  port: number | null;
};

export type LiveListResponse = {
  success: boolean;
  data: LiveServer[];
};

export type BackupStatus = "pending" | "in_progress" | "completed" | "failed";
export type BackupSource = "manual" | "scheduled";
export type BackupOperation = "create" | "restore" | "delete";

export type Backup = {
  id: string;
  serverId: string;
  name: string;
  sizeBytes: number;
  status: BackupStatus;
  source: BackupSource;
  activeOperation: BackupOperation | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
};

export type BackupListResponse = {
  success: boolean;
  data: Backup[];
};

export type BackupSchedule = {
  enabled: boolean;
  frequency: "weekly";
  timezone: "UTC";
  dayOfWeek: number;
  hour: number;
  minute: number;
  retentionCount: number;
  nextRunAt: string | null;
  lastSuccessfulAt: string | null;
};

export type BackupScheduleResponse = {
  success: boolean;
  data: BackupSchedule;
};

export type ChangeStatus = "pending_review" | "approved" | "rejected";

export type ChangeEnvelope = {
  id: string;
  serverId: string;
  serverName: string;
  ruleVersionId: string;
  ruleVersion: number;
  title: string;
  rationale: string;
  source: "form" | "agent" | "director";
  document: Record<string, unknown>;
  contentDigest: string;
  artifactDigest: string;
  runtimeDigest: string;
  runtimeMinecraftVersion: string;
  status: ChangeStatus;
  reviewedArtifactDigest: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  deploymentId: string | null;
  deploymentState: string | null;
  deploymentError: string | null;
  deploymentStartedAt: string | null;
  deploymentFinishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeDiffEntry = {
  kind: "added" | "removed" | "changed";
  path: string;
  before: string | null;
  after: string | null;
  summary: string;
};

export type ChangeTimelineEntry = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type ChangeEnvelopeDetail = ChangeEnvelope & {
  diff: ChangeDiffEntry[];
  timeline: ChangeTimelineEntry[];
};

export type ChangeListResponse = {
  success: boolean;
  data: ChangeEnvelope[];
};

export type ChangeDetailResponse = {
  success: boolean;
  data: ChangeEnvelopeDetail;
};

type ApiErrorBody = Record<string, unknown> | string | null;

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, message: string, body: ApiErrorBody = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function farlandsApiPath(path: string): string {
  return `/api/farlands${path}`;
}

function errorMessage(body: ApiErrorBody, status: number): string {
  if (typeof body === "string" && body.trim()) return body.trim();

  if (body && typeof body === "object") {
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  }

  return `Request failed with status ${status}.`;
}

export async function parseApiError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let body: ApiErrorBody = null;

  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === "string" || (typeof parsed === "object" && parsed !== null)
          ? (parsed as ApiErrorBody)
          : text;
    } catch {
      body = text;
    }
  }

  return new ApiError(response.status, errorMessage(body, response.status), body);
}

export function joinAddress(server: LiveServer): string {
  if (!server.hostname) return "routing not assigned yet";

  if (server.game.toLocaleLowerCase() === "node") {
    if (/^https?:\/\//i.test(server.hostname)) return server.hostname;
    const secure = server.port === 443;
    const port = server.port && ![80, 443].includes(server.port) ? `:${server.port}` : "";
    return `${secure ? "https" : "http"}://${server.hostname}${port}`;
  }

  const defaultPort = server.game.toLocaleLowerCase() === "minecraft" ? 25565 : null;
  const port = server.port && server.port !== defaultPort ? `:${server.port}` : "";
  return `${server.hostname}${port}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(farlandsApiPath(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await parseApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}
