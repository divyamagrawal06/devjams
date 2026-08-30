"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Bell,
  CalendarClock,
  Check,
  CircleAlert,
  Clipboard,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  api,
  joinAddress,
  type LiveServer,
  type MaintenanceWindow,
  type NotificationPreferences,
  type OperatorSummaryResponse,
  type QuotaUsage,
  type WorkloadCatalogueResponse,
} from "@/lib/api";

type PowerAction = "start" | "stop" | "restart";

type OperatorHomeProps = {
  connectorState: "connected" | "checking" | "unavailable";
  operatorName: string;
  onOpenRecovery: (serverId: string) => void;
  quota: QuotaUsage | null;
  quotaError: boolean;
  quotaPending: boolean;
  servers: LiveServer[];
  serversError: boolean;
  serversObservedAt: number;
  serversPending: boolean;
  refreshQuota: () => Promise<unknown>;
  refreshServers: () => Promise<unknown>;
};

export function availablePowerActions(state: string): PowerAction[] {
  if (["stopped", "ready", "failed"].includes(state)) return ["start"];
  if (state === "running") return ["stop", "restart"];
  if (state === "starting") return ["stop"];
  return [];
}

export function freshnessState(
  observedAt: number,
  now: number,
  connectorState: OperatorHomeProps["connectorState"],
) {
  if (!observedAt) return { stale: true, label: "No confirmed observation" };
  const ageSeconds = Math.max(0, Math.floor((now - observedAt) / 1_000));
  const stale = connectorState !== "connected" || ageSeconds > 30;
  return {
    stale,
    label: stale
      ? `Last confirmed ${ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`} ago`
      : `Observed ${ageSeconds < 2 ? "just now" : `${ageSeconds}s ago`}`,
  };
}

export function projectedQuotaIssues(
  quota: QuotaUsage | null,
  requested: { cpuCores: number; ramMb: number; storageGb: number },
): string[] {
  if (!quota) return ["Account quota is unavailable."];
  const issues: string[] = [];
  if (quota.serversUsed + 1 > quota.serversLimit) issues.push("workload count");
  if (Number(quota.cpuUsed) + requested.cpuCores > Number(quota.cpuLimit)) issues.push("CPU");
  if (quota.ramUsedMb + requested.ramMb > quota.ramLimitMb) issues.push("memory");
  if (quota.storageUsedGb + requested.storageGb > quota.storageLimitGb) issues.push("storage");
  return issues;
}

export function shouldClearPowerRequestKey(receiptStatus: string): boolean {
  return receiptStatus === "completed";
}

function stateTone(state: string) {
  if (["running", "ready"].includes(state)) return "good";
  if (["failed", "error"].includes(state)) return "bad";
  if (["stopped", "sleeping"].includes(state)) return "quiet";
  return "working";
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The control-plane request failed.";
}

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

function requestKeyFor(serverId: string, action: PowerAction): string {
  const storageKey = `indexd:power:${serverId}:${action}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `power:${crypto.randomUUID()}`;
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

function clearRequestKey(serverId: string, action: PowerAction) {
  window.sessionStorage.removeItem(`indexd:power:${serverId}:${action}`);
}

function Modal({
  children,
  label,
  onClose,
}: {
  children: React.ReactNode;
  label: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="operator-modal-backdrop">
      <section aria-label={label} aria-modal="true" className="operator-modal" role="dialog">
        <button
          aria-label={`Close ${label}`}
          className="operator-modal-close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
        {children}
      </section>
    </div>
  );
}

function OnboardingDialog({
  onClose,
  onCreated,
  quota,
}: {
  onClose: () => void;
  onCreated: (message: string) => void;
  quota: QuotaUsage | null;
}) {
  const queryClient = useQueryClient();
  const catalogue = useQuery<WorkloadCatalogueResponse>({
    queryKey: ["workload-catalogue"],
    queryFn: () => api<WorkloadCatalogueResponse>("/api/servers/templates"),
    retry: 1,
  });
  const [kindId, setKindId] = useState("minecraft");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.21.4");
  const [runtime, setRuntime] = useState("paper");
  const [loaderVersion, setLoaderVersion] = useState("");
  const [cpuCores, setCpuCores] = useState(1);
  const [ramMb, setRamMb] = useState(1024);
  const [storageGb, setStorageGb] = useState(5);

  const kind = catalogue.data?.data.workloadKinds.find((entry) => entry.id === kindId);
  const selectedRuntime = kind?.runtimes.find((entry) => entry.id === runtime);
  const quotaIssues = projectedQuotaIssues(quota, { cpuCores, ramMb, storageGb });
  const invalid =
    !kind?.available ||
    name.trim().length < 3 ||
    !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(version) ||
    Boolean(selectedRuntime?.loaderVersionRequired && !loaderVersion.trim()) ||
    quotaIssues.length > 0;

  const create = useMutation({
    mutationFn: () =>
      api<{ success: boolean; data: { id: string } }>("/api/servers/create", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          game: "minecraft",
          version,
          type: runtime,
          cpuCores,
          ramMb,
          storageGb,
          gameConfigJson: {
            maxPlayers: 20,
            difficulty: "normal",
            pvp: true,
            ...(selectedRuntime?.loaderVersionRequired
              ? { loaderVersion: loaderVersion.trim() }
              : {}),
          },
        }),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["servers"] }),
        queryClient.invalidateQueries({ queryKey: ["quota"] }),
      ]);
      onCreated(
        `Provisioning completed for ${name.trim()} · receipt ${result.data.id.slice(0, 8)}…`,
      );
      onClose();
    },
  });

  return (
    <Modal label="Create workload" onClose={onClose}>
      <div className="operator-modal-heading">
        <p className="eyebrow">Structured onboarding</p>
        <h2>Create a workload</h2>
        <p>Only connectors reported as available by the backend can be selected.</p>
      </div>

      {catalogue.isPending ? (
        <p className="operator-inline-state" role="status">
          <LoaderCircle className="refreshing" size={17} /> Loading capability catalogue…
        </p>
      ) : null}
      {catalogue.isError ? (
        <div className="operator-inline-error" role="alert">
          <CircleAlert size={18} />
          <span>Capability catalogue unavailable. No workload can be submitted safely.</span>
        </div>
      ) : null}

      {catalogue.data ? (
        <form
          className="onboarding-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) create.mutate();
          }}
        >
          <fieldset className="workload-kind-grid">
            <legend>Workload kind</legend>
            {catalogue.data.data.workloadKinds.map((entry) => (
              <label
                className={entry.available ? "workload-kind" : "workload-kind unavailable"}
                key={entry.id}
              >
                <input
                  checked={kindId === entry.id}
                  disabled={!entry.available}
                  name="workload-kind"
                  onChange={() => {
                    setKindId(entry.id);
                    if (entry.defaultVersion) setVersion(entry.defaultVersion);
                    if (entry.runtimes[0]) setRuntime(entry.runtimes[0].id);
                  }}
                  type="radio"
                />
                <strong>{entry.label}</strong>
                <small>{entry.available ? "Connector ready" : entry.unavailableReason}</small>
              </label>
            ))}
          </fieldset>

          <div className="onboarding-fields">
            <label>
              Workload name
              <input
                maxLength={50}
                minLength={3}
                onChange={(event) => setName(event.target.value)}
                placeholder="survival-main"
                required
                value={name}
              />
            </label>
            <label>
              Exact Minecraft version
              <input
                onChange={(event) => setVersion(event.target.value)}
                pattern="\d{1,2}\.\d{1,2}(\.\d{1,2})?"
                required
                value={version}
              />
            </label>
            <label>
              Runtime
              <select onChange={(event) => setRuntime(event.target.value)} value={runtime}>
                {kind?.runtimes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedRuntime?.loaderVersionRequired ? (
              <label>
                Exact loader version
                <input
                  onChange={(event) => setLoaderVersion(event.target.value)}
                  required
                  value={loaderVersion}
                />
              </label>
            ) : null}
            <label>
              CPU cores
              <input
                max={16}
                min={1}
                onChange={(event) => setCpuCores(Number(event.target.value))}
                required
                type="number"
                value={cpuCores}
              />
            </label>
            <label>
              Memory (MB)
              <input
                max={32768}
                min={512}
                onChange={(event) => setRamMb(Number(event.target.value))}
                required
                step={512}
                type="number"
                value={ramMb}
              />
            </label>
            <label>
              Storage (GB)
              <input
                max={500}
                min={2}
                onChange={(event) => setStorageGb(Number(event.target.value))}
                required
                type="number"
                value={storageGb}
              />
            </label>
          </div>

          <div
            className={quotaIssues.length ? "quota-projection bad" : "quota-projection good"}
            role="status"
          >
            <strong>Projected account usage</strong>
            {quota ? (
              <span>
                {quota.serversUsed + 1}/{quota.serversLimit} workloads ·{" "}
                {Number(quota.cpuUsed) + cpuCores}/{quota.cpuLimit} CPU · {quota.ramUsedMb + ramMb}/
                {quota.ramLimitMb} MB
              </span>
            ) : null}
            {quotaIssues.length ? (
              <span>Blocked by: {quotaIssues.join(", ")}.</span>
            ) : (
              <span>Within current entitlement.</span>
            )}
          </div>

          <p className="onboarding-honesty-note">
            Provisioning contacts the live cluster and may take several minutes. This dialog reports
            completion only after the control plane returns a final result.
          </p>
          {create.isError ? (
            <p className="auth-error" role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
          <div className="operator-modal-actions">
            <button className="billing-secondary-action" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="billing-primary-action"
              disabled={invalid || create.isPending}
              type="submit"
            >
              {create.isPending ? (
                <>
                  <LoaderCircle className="refreshing" size={15} /> Provisioning…
                </>
              ) : (
                <>
                  <Plus size={15} /> Provision workload
                </>
              )}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

function MaintenanceDialog({ onClose, server }: { onClose: () => void; server: LiveServer }) {
  const queryClient = useQueryClient();
  const earliest = new Date(Date.now() + 6 * 60_000);
  earliest.setSeconds(0, 0);
  const [startsAt, setStartsAt] = useState(() => {
    const local = new Date(earliest.getTime() - earliest.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  });
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [action, setAction] = useState<MaintenanceWindow["action"]>("operator_work");
  const [reason, setReason] = useState("");
  const schedule = useMutation({
    mutationFn: () =>
      api("/api/operator/maintenance", {
        method: "POST",
        body: JSON.stringify({
          serverId: server.id,
          startsAt: new Date(startsAt).toISOString(),
          durationMinutes,
          action,
          reason: reason.trim(),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator"] });
      onClose();
    },
  });
  return (
    <Modal label={`Schedule maintenance for ${server.name}`} onClose={onClose}>
      <div className="operator-modal-heading">
        <p className="eyebrow">Maintenance window</p>
        <h2>{server.name}</h2>
        <p>
          This creates a visible planning record. It does not execute or auto-approve any action.
        </p>
      </div>
      <form
        className="onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          schedule.mutate();
        }}
      >
        <div className="onboarding-fields">
          <label>
            Start time
            <input
              min={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
              type="datetime-local"
              value={startsAt}
            />
          </label>
          <label>
            Duration (minutes)
            <input
              max={480}
              min={15}
              onChange={(event) => setDurationMinutes(Number(event.target.value))}
              required
              type="number"
              value={durationMinutes}
            />
          </label>
          <label>
            Planned work
            <select
              onChange={(event) => setAction(event.target.value as MaintenanceWindow["action"])}
              value={action}
            >
              <option value="operator_work">Operator work</option>
              <option value="restart">Restart</option>
            </select>
          </label>
          <label className="wide-field">
            Reason
            <textarea
              maxLength={500}
              minLength={3}
              onChange={(event) => setReason(event.target.value)}
              required
              rows={3}
              value={reason}
            />
          </label>
        </div>
        {schedule.isError ? (
          <p className="auth-error" role="alert">
            {errorMessage(schedule.error)}
          </p>
        ) : null}
        <div className="operator-modal-actions">
          <button className="billing-secondary-action" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="billing-primary-action"
            disabled={reason.trim().length < 3 || schedule.isPending}
            type="submit"
          >
            Schedule window
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NotificationSettings({ preferences }: { preferences: NotificationPreferences }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(preferences);
  const save = useMutation({
    mutationFn: () =>
      api("/api/operator/notifications", { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["operator"] }),
  });
  const toggles = [
    ["deploymentEvents", "Deployment receipts"],
    ["backupEvents", "Backup and recovery receipts"],
    ["billingEvents", "Billing entitlement changes"],
    ["maintenanceEvents", "Maintenance windows"],
  ] as const;
  return (
    <details className="operator-settings">
      <summary>
        <Bell aria-hidden="true" size={17} /> Notification preferences
      </summary>
      <p>
        These preferences affect the in-app inbox only. Email and push delivery are not connected.
      </p>
      <div className="notification-grid">
        {toggles.map(([field, label]) => (
          <label key={field}>
            <input
              checked={form[field]}
              onChange={(event) =>
                setForm((current) => ({ ...current, [field]: event.target.checked }))
              }
              type="checkbox"
            />
            {label}
          </label>
        ))}
        <label>
          Timezone
          <input
            maxLength={64}
            onChange={(event) =>
              setForm((current) => ({ ...current, timezone: event.target.value }))
            }
            value={form.timezone}
          />
        </label>
      </div>
      <button
        className="billing-secondary-action"
        disabled={save.isPending}
        onClick={() => save.mutate()}
        type="button"
      >
        {save.isPending ? "Saving…" : "Save preferences"}
      </button>
      {save.isError ? (
        <p className="auth-error" role="alert">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </details>
  );
}

export function OperatorHome({
  connectorState,
  operatorName,
  onOpenRecovery,
  quota,
  quotaError,
  quotaPending,
  refreshQuota,
  refreshServers,
  servers,
  serversError,
  serversObservedAt,
  serversPending,
}: OperatorHomeProps) {
  const queryClient = useQueryClient();
  const now = useClock();
  const freshness = freshnessState(serversObservedAt, now, connectorState);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    server: LiveServer;
    action: PowerAction;
  } | null>(null);
  const [maintenanceServer, setMaintenanceServer] = useState<LiveServer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);

  const operator = useQuery<OperatorSummaryResponse>({
    queryKey: ["operator"],
    queryFn: () => api<OperatorSummaryResponse>("/api/operator"),
    refetchInterval: 15_000,
    retry: 1,
  });
  const action = useMutation({
    mutationFn: async ({
      server,
      action: powerAction,
    }: {
      server: LiveServer;
      action: PowerAction;
    }) => {
      const requestKey = requestKeyFor(server.id, powerAction);
      return api<{
        success: boolean;
        data: { status: string; receipt: { receiptId: string; status: string } };
      }>(`/api/servers/${encodeURIComponent(server.id)}/action`, {
        method: "POST",
        body: JSON.stringify({ action: powerAction, requestKey }),
      });
    },
    onSuccess: async (result, input) => {
      const receiptCompleted = shouldClearPowerRequestKey(result.data.receipt.status);
      if (receiptCompleted) clearRequestKey(input.server.id, input.action);
      setNotice(
        receiptCompleted
          ? `${input.server.name}: ${humanize(result.data.status)} · receipt ${result.data.receipt.receiptId.slice(0, 12)}…`
          : `${input.server.name}: ${humanize(result.data.receipt.status)}; final state is not yet observed. The same request key is retained.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["servers"] }),
        queryClient.invalidateQueries({ queryKey: ["operator"] }),
      ]);
    },
  });
  const cancelMaintenance = useMutation({
    mutationFn: (id: string) =>
      api(`/api/operator/maintenance/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["operator"] }),
  });

  const serverNames = useMemo(
    () => new Map(servers.map((server) => [server.id, server.name])),
    [servers],
  );
  const controlsDisabled = freshness.stale || action.isPending;

  async function refreshAll() {
    await Promise.all([refreshServers(), refreshQuota(), operator.refetch()]);
  }

  async function copyAddress(server: LiveServer) {
    if (!server.hostname) return;
    try {
      await navigator.clipboard.writeText(joinAddress(server));
      setCopyState(server.id);
      window.setTimeout(() => setCopyState(null), 2_000);
    } catch {
      setNotice(`Could not copy the address for ${server.name}.`);
    }
  }

  function requestAction(server: LiveServer, powerAction: PowerAction) {
    if (powerAction === "start") action.mutate({ server, action: powerAction });
    else setConfirmation({ server, action: powerAction });
  }

  return (
    <div className="operator-home">
      <div className="window-hero operator-hero">
        <div>
          <p className="eyebrow">
            {servers.length} {servers.length === 1 ? "workload" : "workloads"} assigned
          </p>
          <h2>Operator Home</h2>
          <p>
            Welcome, {operatorName}. Power controls, receipts, recovery, and scheduled work share
            one observed view.
          </p>
        </div>
        <div className="operator-hero-actions">
          <span className={freshness.stale ? "freshness-chip stale" : "freshness-chip"}>
            {freshness.label}
          </span>
          <button
            className="inline-action"
            disabled={serversPending}
            onClick={() => void refreshAll()}
            type="button"
          >
            <RefreshCw className={serversPending ? "refreshing" : ""} size={15} /> Refresh
          </button>
          <button
            className="billing-primary-action"
            onClick={() => setOnboardingOpen(true)}
            type="button"
          >
            <Plus size={15} /> Create workload
          </button>
        </div>
      </div>

      {freshness.stale ? (
        <div className="operator-safety-banner" role="status">
          <ShieldCheck size={18} />
          <span>Direct controls are paused until a fresh control-plane observation succeeds.</span>
        </div>
      ) : null}
      {notice ? (
        <div className="billing-notice good" role="status">
          <Check size={17} />
          <span>{notice}</span>
        </div>
      ) : null}
      {action.isError ? (
        <div className="operator-inline-error" role="alert">
          <CircleAlert size={18} />
          <span>
            {errorMessage(action.error)} The request key is retained so Retry cannot duplicate the
            operation.
          </span>
        </div>
      ) : null}

      {serversPending ? (
        <div className="operator-loading" role="status">
          <LoaderCircle className="refreshing" size={20} /> Loading observed workload state…
        </div>
      ) : null}
      {serversError ? (
        <div className="query-state error-state" role="alert">
          <CircleAlert size={23} />
          <div>
            <h3>Workload state is unavailable</h3>
            <p>The last confirmed state is not presented as live. Retry the connector.</p>
          </div>
          <button className="inline-action" onClick={() => void refreshAll()} type="button">
            Retry
          </button>
        </div>
      ) : null}
      {!serversPending && !serversError && servers.length === 0 ? (
        <div className="empty-state">
          <Server size={29} />
          <h3>Create your first workload</h3>
          <p>
            Start with a backend-supported template and see its exact quota effect before
            provisioning.
          </p>
          <button
            className="billing-primary-action"
            onClick={() => setOnboardingOpen(true)}
            type="button"
          >
            <Plus size={15} /> Create first workload
          </button>
        </div>
      ) : null}

      {servers.length ? (
        <div className="operator-workload-list">
          {servers.map((server) => {
            const validActions = availablePowerActions(server.currentState);
            return (
              <article className="operator-workload" key={server.id}>
                <div className="operator-workload-status">
                  <span className={`status-dot ${stateTone(server.currentState)}`} />
                  <div>
                    <h3>{server.name}</h3>
                    <p>
                      {server.type} {server.version} · {server.game}
                    </p>
                  </div>
                  <span className={`state-label ${stateTone(server.currentState)}`}>
                    {humanize(server.currentState)}
                  </span>
                </div>
                <dl className="operator-resource-strip">
                  <div>
                    <dt>Address</dt>
                    <dd>{joinAddress(server)}</dd>
                  </div>
                  <div>
                    <dt>CPU</dt>
                    <dd>{server.cpuCores ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Memory</dt>
                    <dd>{server.ramMb ? `${server.ramMb} MB` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Storage</dt>
                    <dd>{server.storageGb ? `${server.storageGb} GB` : "—"}</dd>
                  </div>
                </dl>
                {server.statusMessage ? (
                  <p className="realm-message">{server.statusMessage}</p>
                ) : null}
                <div className="operator-control-row">
                  {(["start", "stop", "restart"] as const).map((powerAction) => {
                    const Icon =
                      powerAction === "start" ? Play : powerAction === "stop" ? Pause : RotateCw;
                    return (
                      <button
                        className="operator-control"
                        disabled={controlsDisabled || !validActions.includes(powerAction)}
                        key={powerAction}
                        onClick={() => requestAction(server, powerAction)}
                        type="button"
                      >
                        <Icon size={15} /> {humanize(powerAction)}
                      </button>
                    );
                  })}
                  <button
                    className="operator-control"
                    disabled={!server.hostname}
                    onClick={() => void copyAddress(server)}
                    type="button"
                  >
                    <Clipboard size={15} /> {copyState === server.id ? "Copied" : "Copy address"}
                  </button>
                  <button
                    className="operator-control"
                    onClick={() => onOpenRecovery(server.id)}
                    type="button"
                  >
                    <ArchiveRestore size={15} /> Recovery
                  </button>
                  <button
                    className="operator-control"
                    onClick={() => setMaintenanceServer(server)}
                    type="button"
                  >
                    <CalendarClock size={15} /> Maintenance
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <div className="operator-lower-grid">
        <section className="operator-panel" aria-labelledby="maintenance-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Planned work</p>
              <h3 id="maintenance-heading">Maintenance windows</h3>
            </div>
            <CalendarClock size={18} />
          </div>
          {operator.isError ? (
            <p className="operator-muted">Maintenance records unavailable.</p>
          ) : null}
          {!operator.isPending && operator.data?.data.maintenanceWindows.length === 0 ? (
            <p className="operator-muted">No upcoming maintenance.</p>
          ) : null}
          <div className="maintenance-list">
            {operator.data?.data.maintenanceWindows
              .filter((window) => window.status === "scheduled")
              .map((window) => (
                <article key={window.id}>
                  <div>
                    <strong>{serverNames.get(window.serverId) ?? "Workload"}</strong>
                    <span>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(window.startsAt))}{" "}
                      · {window.durationMinutes} min
                    </span>
                    <small>
                      {humanize(window.action)} · {window.reason}
                    </small>
                  </div>
                  <button
                    aria-label={`Cancel maintenance for ${serverNames.get(window.serverId) ?? "workload"}`}
                    disabled={cancelMaintenance.isPending}
                    onClick={() => cancelMaintenance.mutate(window.id)}
                    type="button"
                  >
                    <X size={15} />
                  </button>
                </article>
              ))}
          </div>
        </section>
        <section className="operator-panel" aria-labelledby="receipts-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Durable history</p>
              <h3 id="receipts-heading">Recent control receipts</h3>
            </div>
            <Power size={18} />
          </div>
          {!operator.isPending && operator.data?.data.receipts.length === 0 ? (
            <p className="operator-muted">No direct-control receipts yet.</p>
          ) : null}
          <div className="receipt-list">
            {operator.data?.data.receipts.slice(0, 8).map((receipt) => (
              <article key={receipt.id}>
                <span
                  className={`status-dot ${receipt.status === "completed" ? "good" : receipt.status === "failed" || receipt.status === "refused" ? "bad" : "working"}`}
                />
                <div>
                  <strong>
                    {humanize(receipt.action)} · {serverNames.get(receipt.serverId) ?? "Workload"}
                  </strong>
                  <span>
                    {humanize(receipt.status)}
                    {receipt.observedState ? ` · observed ${humanize(receipt.observedState)}` : ""}
                  </span>
                  <small>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(receipt.acceptedAt))}{" "}
                    · {receipt.id.slice(0, 14)}…
                  </small>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="operator-panel operator-quota-summary">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current entitlement</p>
            <h3>Aggregate account quota</h3>
          </div>
          {quota?.overQuota ? <CircleAlert className="bad-icon" size={18} /> : <Check size={18} />}
        </div>
        {quotaPending ? <p className="operator-muted">Loading aggregate quota…</p> : null}
        {quotaError ? (
          <p className="operator-muted">Quota is unavailable; onboarding remains blocked.</p>
        ) : null}
        {quota ? (
          <p>
            {quota.serversUsed}/{quota.serversLimit} workloads · {quota.cpuUsed}/{quota.cpuLimit}{" "}
            CPU · {quota.ramUsedMb}/{quota.ramLimitMb} MB · {quota.storageUsedGb}/
            {quota.storageLimitGb} GB · {quota.backupsUsed}/{quota.backupsLimit} backups
            {quota.overQuota ? " · Existing workloads preserved; new allocation blocked" : ""}
          </p>
        ) : null}
      </section>

      {operator.data ? (
        <NotificationSettings
          key={JSON.stringify(operator.data.data.notificationPreferences)}
          preferences={operator.data.data.notificationPreferences}
        />
      ) : null}

      {onboardingOpen ? (
        <OnboardingDialog
          onClose={() => setOnboardingOpen(false)}
          onCreated={setNotice}
          quota={quota}
        />
      ) : null}
      {maintenanceServer ? (
        <MaintenanceDialog onClose={() => setMaintenanceServer(null)} server={maintenanceServer} />
      ) : null}
      {confirmation ? (
        <Modal
          label={`${humanize(confirmation.action)} ${confirmation.server.name}`}
          onClose={() => setConfirmation(null)}
        >
          <div className="operator-modal-heading">
            <p className="eyebrow">Confirm direct control</p>
            <h2>
              {humanize(confirmation.action)} {confirmation.server.name}?
            </h2>
            <p>
              The control plane will wait for an observed result and write a durable receipt.
              Players may be disconnected.
            </p>
          </div>
          <div className="operator-modal-actions">
            <button
              className="billing-secondary-action"
              onClick={() => setConfirmation(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="danger-action"
              onClick={() => {
                action.mutate(confirmation);
                setConfirmation(null);
              }}
              type="button"
            >
              Confirm {confirmation.action}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
