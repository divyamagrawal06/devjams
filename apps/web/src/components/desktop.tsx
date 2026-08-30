"use client";

import { useQuery } from "@tanstack/react-query";
import { motion, type PanInfo, useDragControls, useReducedMotion } from "framer-motion";
import {
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  ClipboardCheck,
  Cpu,
  Database,
  Hammer,
  HardDrive,
  LogOut,
  type LucideIcon,
  Map as MapIcon,
  MemoryStick,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, joinAddress, type LiveListResponse, type LiveServer } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { desktopWindowForRoute, isDesktopApp } from "@/lib/routes";
import { AllayCompanion } from "./allay-companion";
import { BackupsWindow } from "./backups-window";
import { BillingPanel } from "./billing-panel";
import { PanoramaBackground } from "./panorama-background";
import { ReviewQueueWindow } from "./review-queue-window";
import { RuleForgeWindow } from "./rule-forge-window";
import { TrustLedgerWindow } from "./trust-ledger-window";

type AppId = "realms" | "backups" | "review" | "forge" | "activity" | "account";

type AppDefinition = {
  id: AppId;
  label: string;
  detail: string;
  icon: LucideIcon;
  color: string;
};

type HealthResponse = {
  status: string;
  db?: string;
};

type QuotaUsage = {
  cpuLimit: string | number;
  cpuUsed: string | number;
  ramLimitMb: number;
  ramUsedMb: number;
  storageLimitGb: number;
  storageUsedGb: number;
  serversLimit: number;
  serversUsed: number;
  deploymentHeadroomReserved?: boolean;
};

type QuotaResponse = {
  success: boolean;
  data: QuotaUsage;
};

type WindowState = {
  appId: AppId;
  x: number;
  y: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
};

const initialWindows: WindowState[] = [
  { appId: "realms", x: 210, y: 176, z: 1, minimized: false, maximized: false },
];

function nextWindowZ(items: WindowState[]) {
  return Math.max(0, ...items.map((item) => item.z)) + 1;
}

function stateTone(state: string) {
  const normalized = state.toLowerCase();
  if (normalized === "running" || normalized === "ready") return "good";
  if (normalized === "failed" || normalized === "error") return "bad";
  if (normalized === "stopped" || normalized === "sleeping") return "quiet";
  return "working";
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstName(name: string | null | undefined, email: string | undefined) {
  const resolved = name?.trim() || email?.split("@")[0] || "operator";
  return resolved.split(/\s+/)[0];
}

function initials(name: string | null | undefined, email: string | undefined) {
  const source = name?.trim() || email?.split("@")[0] || "I";
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatMemory(megabytes: number) {
  if (megabytes >= 1024) {
    const gigabytes = megabytes / 1024;
    return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
  }
  return `${megabytes} MB`;
}

function useCompactViewport() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function DesktopClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const interval = window.setInterval(update, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  if (!now) {
    return (
      <div className="taskbar-time" role="status">
        <span className="sr-only">Loading local time</span>
        <span aria-hidden="true">--:--</span>
      </div>
    );
  }

  return (
    <time className="taskbar-time" dateTime={now.toISOString()}>
      {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)}
      <span>
        {new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(now)}
      </span>
    </time>
  );
}

function LoadingRows() {
  return (
    <div className="realm-list" role="status">
      <span className="sr-only">Loading realms</span>
      {[0, 1, 2].map((item) => (
        <div className="realm-skeleton" key={item}>
          <span />
          <div>
            <span />
            <span />
          </div>
        </div>
      ))}
    </div>
  );
}

function RealmRow({
  copied,
  copyError,
  onBackups,
  onCopy,
  server,
}: {
  copied: boolean;
  copyError: boolean;
  onBackups: (server: LiveServer) => void;
  onCopy: (server: LiveServer) => void;
  server: LiveServer;
}) {
  const address = joinAddress(server);
  const routable = Boolean(server.hostname);
  const detail = [server.type, server.version, server.game].filter(Boolean).join(" · ");
  const desiredDiffers = server.desiredState && server.desiredState !== server.currentState;

  return (
    <article className="realm-row">
      <span className={`status-dot ${stateTone(server.currentState)}`} aria-hidden="true" />
      <div className="realm-main">
        <div className="realm-name-line">
          <h3>{server.name}</h3>
          <span className={`state-label ${stateTone(server.currentState)}`}>
            {humanize(server.currentState)}
          </span>
        </div>
        <p className={routable ? "realm-address" : "realm-address pending"}>{address}</p>
        <p className="realm-meta">
          {detail || "Server details pending"}
          {desiredDiffers ? ` · Target ${humanize(server.desiredState)}` : ""}
        </p>
        {server.statusMessage ? <p className="realm-message">{server.statusMessage}</p> : null}
      </div>
      <div className="realm-actions">
        <button
          aria-label={
            routable ? `Copy address for ${server.name}` : `Address pending for ${server.name}`
          }
          className="copy-button"
          disabled={!routable}
          onClick={() => onCopy(server)}
          type="button"
        >
          {copied ? <Check size={16} /> : <Clipboard size={16} />}
          <span>{copied ? "Copied" : routable ? "Copy" : "Pending"}</span>
        </button>
        <button
          aria-label={`Open backups for ${server.name}`}
          className="copy-button"
          onClick={() => onBackups(server)}
          type="button"
        >
          <Archive aria-hidden="true" size={16} />
          <span>Backups</span>
        </button>
      </div>
      {copyError ? (
        <span className="copy-error" role="alert">
          Copy failed
        </span>
      ) : null}
    </article>
  );
}

type WindowBodyProps = {
  appId: AppId;
  copiedServerId: string | null;
  copyErrorServerId: string | null;
  health: ReturnType<typeof useQuery<HealthResponse>>;
  onOpenBackups: (serverId: string) => void;
  onOpenReview: (changeId: string) => void;
  onCopy: (server: LiveServer) => void;
  onSelectChange: (changeId: string) => void;
  onSelectBackupServer: (serverId: string) => void;
  quota: ReturnType<typeof useQuery<QuotaResponse>>;
  selectedBackupServerId: string | null;
  selectedChangeId: string | null;
  servers: ReturnType<typeof useQuery<LiveListResponse>>;
  signOutError: string | null;
  signingOut: boolean;
  user: {
    name?: string | null;
    email?: string;
    emailVerified?: boolean;
  } | null;
  onSignOut: () => void;
};

function WindowBody({
  appId,
  copiedServerId,
  copyErrorServerId,
  health,
  onCopy,
  onOpenBackups,
  onOpenReview,
  onSelectChange,
  onSelectBackupServer,
  onSignOut,
  quota,
  selectedBackupServerId,
  selectedChangeId,
  servers,
  signOutError,
  signingOut,
  user,
}: WindowBodyProps) {
  if (appId === "realms") {
    const realmCount = servers.data?.data.length;
    return (
      <>
        <div className="window-hero">
          <p className="eyebrow">
            {realmCount === undefined
              ? "Checking your realm scope"
              : `${realmCount} ${realmCount === 1 ? "realm" : "realms"} assigned`}
          </p>
          <h2>Welcome, {firstName(user?.name, user?.email)}.</h2>
          <p>
            {health.isError
              ? "The connector is unavailable, so realm status may not be loaded."
              : health.data?.status === "ok"
                ? "Status below comes directly from the live control plane."
                : "Opening a secure connection to the control plane."}
          </p>
        </div>

        {servers.isPending ? <LoadingRows /> : null}

        {servers.isError ? (
          <div className="query-state error-state" role="alert">
            <WifiOff aria-hidden="true" size={24} />
            <div>
              <h3>Realm data could not be loaded</h3>
              <p>Your session is still active. Retry the connector without signing in again.</p>
            </div>
            <button className="inline-action" onClick={() => void servers.refetch()} type="button">
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        ) : null}

        {servers.data?.data.length === 0 ? (
          <div className="empty-state">
            <Server aria-hidden="true" size={29} />
            <h3>No realms assigned to this account</h3>
            <p>
              When a realm is created for this Google account, its live state and join address will
              appear here.
            </p>
          </div>
        ) : null}

        {servers.data?.data.length ? (
          <div className="realm-list">
            {servers.data.data.map((server) => (
              <RealmRow
                copied={copiedServerId === server.id}
                copyError={copyErrorServerId === server.id}
                key={server.id}
                onBackups={(selectedServer) => onOpenBackups(selectedServer.id)}
                onCopy={onCopy}
                server={server}
              />
            ))}
          </div>
        ) : null}
      </>
    );
  }

  if (appId === "backups") {
    return (
      <BackupsWindow
        onRetryServers={() => void servers.refetch()}
        onSelectServer={onSelectBackupServer}
        selectedServerId={selectedBackupServerId}
        servers={servers.data?.data ?? []}
        serversError={servers.isError}
        serversPending={servers.isPending}
      />
    );
  }

  if (appId === "review") {
    return (
      <ReviewQueueWindow onSelectChange={onSelectChange} selectedChangeId={selectedChangeId} />
    );
  }

  if (appId === "forge") {
    return <RuleForgeWindow onOpenReview={onOpenReview} servers={servers.data?.data ?? []} />;
  }

  if (appId === "activity") {
    return <TrustLedgerWindow servers={servers.data?.data ?? []} />;
  }

  const quotaData = quota.data?.data;
  return (
    <div className="account-view">
      <div className="account-heading">
        <span className="account-avatar" aria-hidden="true">
          {initials(user?.name, user?.email)}
        </span>
        <div>
          <p className="eyebrow">Signed-in operator</p>
          <h2>{user?.name || "indexd operator"}</h2>
          <p>{user?.email || "Email unavailable"}</p>
        </div>
      </div>

      <dl className="account-status-list">
        <div>
          <dt>
            <UserRound aria-hidden="true" size={17} /> Account
          </dt>
          <dd>
            <span className="status-dot good" aria-hidden="true" />
            {user ? "Authenticated" : "Checking session"}
          </dd>
        </div>
        <div>
          <dt>
            <ShieldCheck aria-hidden="true" size={17} /> Google identity
          </dt>
          <dd>{user?.emailVerified === false ? "Email not verified" : "Connected"}</dd>
        </div>
        <div>
          <dt>
            <Database aria-hidden="true" size={17} /> Control plane
          </dt>
          <dd>
            <span
              className={`status-dot ${health.isError ? "bad" : health.data?.status === "ok" ? "good" : "working"}`}
              aria-hidden="true"
            />
            {health.isError
              ? "Unavailable"
              : health.data?.status === "ok"
                ? "Connected"
                : "Checking"}
          </dd>
        </div>
      </dl>

      <div className="quota-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Account limits</p>
            <h3>Current resource usage</h3>
          </div>
          {quota.isFetching && !quota.isPending ? (
            <RefreshCw className="refreshing" aria-label="Refreshing quota" size={16} />
          ) : null}
        </div>

        {quota.isPending ? (
          <div className="quota-loading" role="status">
            <span className="sr-only">Loading account limits</span>
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {quota.isError ? (
          <div className="quota-unavailable" role="status">
            <CircleAlert aria-hidden="true" size={18} />
            Account limits are unavailable from the connector.
          </div>
        ) : null}

        {quotaData ? (
          <dl className="quota-list">
            <div>
              <dt>
                <Server aria-hidden="true" size={17} /> Realms
              </dt>
              <dd>
                {quotaData.serversUsed} of {quotaData.serversLimit}
              </dd>
            </div>
            <div>
              <dt>
                <Cpu aria-hidden="true" size={17} /> CPU
              </dt>
              <dd>
                {quotaData.cpuUsed} of {quotaData.cpuLimit} cores
              </dd>
            </div>
            <div>
              <dt>
                <MemoryStick aria-hidden="true" size={17} /> Memory
              </dt>
              <dd>
                {formatMemory(quotaData.ramUsedMb)} of {formatMemory(quotaData.ramLimitMb)}
              </dd>
            </div>
            <div>
              <dt>
                <HardDrive aria-hidden="true" size={17} /> Storage
              </dt>
              <dd>
                {quotaData.storageUsedGb} of {quotaData.storageLimitGb} GB
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      <BillingPanel />

      <div className="account-actions">
        <p>Signing out clears this browser session. It does not stop or change any realm.</p>
        <button className="sign-out-button" disabled={signingOut} onClick={onSignOut} type="button">
          <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
      {signOutError ? (
        <p className="auth-error account-error" role="alert">
          {signOutError}
        </p>
      ) : null}
    </div>
  );
}

function DesktopWindow({
  app,
  children,
  compact,
  onClose,
  onDragEnd,
  onFocus,
  onMinimize,
  onToggleMaximize,
  windowState,
}: {
  app: AppDefinition;
  children: React.ReactNode;
  compact: boolean;
  onClose: () => void;
  onDragEnd: (info: PanInfo) => void;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  windowState: WindowState;
}) {
  const dragControls = useDragControls();
  const reducedMotion = useReducedMotion();
  const titleId = `window-title-${app.id}`;
  const Icon = app.icon;

  return (
    <motion.section
      animate={{ opacity: 1, scale: 1, y: 0 }}
      aria-labelledby={titleId}
      className={`app-window pixel-border ${windowState.maximized ? "maximized" : ""}`}
      drag={!windowState.maximized && !compact}
      dragControls={dragControls}
      dragElastic={0}
      dragListener={false}
      dragMomentum={false}
      initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 }}
      onDragEnd={(_event, info) => onDragEnd(info)}
      onPointerDown={onFocus}
      style={
        windowState.maximized || compact
          ? { zIndex: windowState.z }
          : {
              left: windowState.x,
              maxHeight: `calc(100svh - ${windowState.y + 64}px)`,
              top: windowState.y,
              zIndex: windowState.z,
            }
      }
      transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        aria-label={`${app.label} window controls`}
        className="window-bar"
        onDoubleClick={onToggleMaximize}
        onPointerDown={(event) => {
          if (!windowState.maximized && !compact) dragControls.start(event);
        }}
        role="toolbar"
      >
        <div className="window-title" id={titleId}>
          <span style={{ color: app.color }}>
            <Icon aria-hidden="true" size={17} />
          </span>
          {app.label}
        </div>
        <div className="window-controls">
          <button
            aria-label={`Minimize ${app.label}`}
            onClick={onMinimize}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <span aria-hidden="true">−</span>
          </button>
          <button
            aria-label={`${windowState.maximized ? "Restore" : "Maximize"} ${app.label}`}
            onClick={onToggleMaximize}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <span aria-hidden="true">{windowState.maximized ? "❐" : "□"}</span>
          </button>
          <button
            aria-label={`Close ${app.label}`}
            className="close-control"
            onClick={onClose}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      </div>
      <div className="window-content">{children}</div>
    </motion.section>
  );
}

export function Desktop() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;
  const compact = useCompactViewport();
  const [windows, setWindows] = useState<WindowState[]>(initialWindows);
  const [selectedBackupServerId, setSelectedBackupServerId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [copiedServerId, setCopiedServerId] = useState<string | null>(null);
  const [copyErrorServerId, setCopyErrorServerId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    const route = new URLSearchParams(window.location.search).get("app");
    if (!isDesktopApp(route)) return;
    const appId = desktopWindowForRoute(route);
    setWindows((items) => {
      if (items.some((item) => item.appId === appId)) {
        return items.map((item) =>
          item.appId === appId ? { ...item, minimized: false, z: nextWindowZ(items) } : item,
        );
      }
      const offset = 30 * (items.length % 5);
      return [
        ...items,
        {
          appId,
          x: 118 + offset,
          y: 108 + offset,
          z: nextWindowZ(items),
          minimized: false,
          maximized: false,
        },
      ];
    });
  }, []);

  useEffect(() => {
    const billingResult = new URLSearchParams(window.location.search).get("billing");
    if (billingResult !== "return" && billingResult !== "cancel") return;

    setWindows((items) => {
      if (items.some((item) => item.appId === "account")) {
        return items.map((item) =>
          item.appId === "account" ? { ...item, minimized: false, z: nextWindowZ(items) } : item,
        );
      }

      const offset = 30 * (items.length % 5);
      return [
        ...items,
        {
          appId: "account",
          x: 118 + offset,
          y: 108 + offset,
          z: nextWindowZ(items),
          minimized: false,
          maximized: false,
        },
      ];
    });
  }, []);

  const health = useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: () => api<HealthResponse>("/health"),
    enabled: Boolean(user),
    refetchInterval: 15_000,
    retry: 1,
  });

  const servers = useQuery<LiveListResponse>({
    queryKey: ["servers"],
    queryFn: () => api<LiveListResponse>("/api/servers"),
    enabled: Boolean(user),
    refetchInterval: 10_000,
    retry: 1,
  });

  const quota = useQuery<QuotaResponse>({
    queryKey: ["quota"],
    queryFn: () => api<QuotaResponse>("/api/quota"),
    enabled: Boolean(user),
    refetchInterval: 30_000,
    retry: 1,
  });

  const apps = useMemo<AppDefinition[]>(() => {
    const realmCount = servers.data?.data.length;
    return [
      {
        id: "realms",
        label: "My Realms",
        detail:
          realmCount === undefined
            ? "Checking…"
            : `${realmCount} ${realmCount === 1 ? "realm" : "realms"}`,
        icon: Server,
        color: "oklch(0.55 0.09 54)",
      },
      {
        id: "backups",
        label: "Backups",
        detail: realmCount === 0 ? "No realms" : "Recovery points",
        icon: Archive,
        color: "oklch(0.58 0.09 86)",
      },
      {
        id: "review",
        label: "Review Queue",
        detail: "Exact human gate",
        icon: ClipboardCheck,
        color: "oklch(0.63 0.10 70)",
      },
      {
        id: "forge",
        label: "Rule Forge",
        detail: "Bounded JSON rules",
        icon: Hammer,
        color: "oklch(0.58 0.08 48)",
      },
      {
        id: "activity",
        label: "Trust Ledger",
        detail: "Durable receipts",
        icon: ScrollText,
        color: "oklch(0.52 0.07 34)",
      },
      {
        id: "account",
        label: "Account",
        detail: user?.email || "Signed in",
        icon: UserRound,
        color: "oklch(0.59 0.06 75)",
      },
    ];
  }, [servers.data?.data.length, user?.email]);

  const focus = (appId: AppId) =>
    setWindows((items) =>
      items.map((item) =>
        item.appId === appId ? { ...item, z: nextWindowZ(items), minimized: false } : item,
      ),
    );

  const open = (appId: AppId) =>
    setWindows((items) => {
      if (items.some((item) => item.appId === appId)) {
        return items.map((item) =>
          item.appId === appId ? { ...item, minimized: false, z: nextWindowZ(items) } : item,
        );
      }

      const offset = 30 * (items.length % 5);
      return [
        ...items,
        {
          appId,
          x: 118 + offset,
          y: 108 + offset,
          z: nextWindowZ(items),
          minimized: false,
          maximized: false,
        },
      ];
    });

  const openBackups = (serverId?: string) => {
    if (serverId) {
      setSelectedBackupServerId(serverId);
    } else if (!selectedBackupServerId && servers.data?.data[0]) {
      setSelectedBackupServerId(servers.data.data[0].id);
    }
    open("backups");
  };

  const openReview = (changeId: string) => {
    setSelectedChangeId(changeId);
    open("review");
  };

  const close = (appId: AppId) =>
    setWindows((items) => items.filter((item) => item.appId !== appId));

  const minimize = (appId: AppId) =>
    setWindows((items) =>
      items.map((item) => (item.appId === appId ? { ...item, minimized: true } : item)),
    );

  const toggleMaximize = (appId: AppId) =>
    setWindows((items) =>
      items.map((item) =>
        item.appId === appId
          ? {
              ...item,
              maximized: !item.maximized,
              minimized: false,
              z: nextWindowZ(items),
            }
          : item,
      ),
    );

  const move = (appId: AppId, info: PanInfo) =>
    setWindows((items) =>
      items.map((item) => {
        if (item.appId !== appId) return item;
        const maxX = Math.max(12, window.innerWidth - 320);
        const maxY = Math.max(58, window.innerHeight - 464);
        return {
          ...item,
          x: Math.min(maxX, Math.max(12, item.x + info.offset.x)),
          y: Math.min(maxY, Math.max(58, item.y + info.offset.y)),
        };
      }),
    );

  async function copyAddress(server: LiveServer) {
    if (!server.hostname) return;
    setCopyErrorServerId(null);
    try {
      await navigator.clipboard.writeText(joinAddress(server));
      setCopiedServerId(server.id);
      window.setTimeout(() => setCopiedServerId(null), 2_000);
    } catch {
      setCopyErrorServerId(server.id);
      window.setTimeout(() => setCopyErrorServerId(null), 3_000);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setSignOutError(result.error.message ?? "Sign out failed. Please try again.");
        setSigningOut(false);
        return;
      }
      window.location.assign("/");
    } catch {
      setSignOutError("Sign out failed. Please try again.");
      setSigningOut(false);
    }
  }

  const runningCount = servers.data?.data.filter(
    (server) => server.currentState === "running" || server.currentState === "ready",
  ).length;
  const totalCount = servers.data?.data.length;
  const connectorStatus = health.isError
    ? "Connector unavailable"
    : health.data?.status === "ok"
      ? totalCount === undefined
        ? "Control plane connected"
        : totalCount === 0
          ? "Connected, no realms yet"
          : `${runningCount} of ${totalCount} realms running`
      : "Connecting to control plane";

  return (
    <main className="mc-desktop">
      <PanoramaBackground />
      <div className="desktop-sky" />

      <header className="desktop-topbar">
        <div className="brand-mark">
          <MapIcon aria-hidden="true" size={18} />
          <span>indexd</span>
        </div>
        <div className="topbar-actions">
          <div className="topbar-status" aria-live="polite">
            {health.isError ? (
              <WifiOff aria-hidden="true" size={16} />
            ) : (
              <Wifi aria-hidden="true" size={16} />
            )}
            <span>{connectorStatus}</span>
          </div>
          <button
            aria-label="Open account"
            className="topbar-account"
            onClick={() => open("account")}
            type="button"
          >
            {initials(user?.name, user?.email)}
          </button>
        </div>
      </header>

      <section className="desktop-icons" aria-label="Desktop applications">
        {apps.map((app) => {
          const Icon = app.icon;
          return (
            <button
              className="desktop-icon"
              key={app.id}
              onClick={() => (app.id === "backups" ? openBackups() : open(app.id))}
              type="button"
            >
              <span className="icon-tile" style={{ color: app.color }}>
                <Icon aria-hidden="true" size={27} strokeWidth={2.25} />
              </span>
              <strong>{app.label}</strong>
              <small>{app.detail}</small>
            </button>
          );
        })}
      </section>

      {windows
        .filter((item) => !item.minimized)
        .map((windowState) => {
          const app = apps.find((entry) => entry.id === windowState.appId);
          if (!app) return null;
          return (
            <DesktopWindow
              app={app}
              compact={compact}
              key={windowState.appId}
              onClose={() => close(windowState.appId)}
              onDragEnd={(info) => move(windowState.appId, info)}
              onFocus={() => focus(windowState.appId)}
              onMinimize={() => minimize(windowState.appId)}
              onToggleMaximize={() => toggleMaximize(windowState.appId)}
              windowState={windowState}
            >
              <WindowBody
                appId={windowState.appId}
                copiedServerId={copiedServerId}
                copyErrorServerId={copyErrorServerId}
                health={health}
                onCopy={copyAddress}
                onOpenBackups={openBackups}
                onOpenReview={openReview}
                onSelectChange={setSelectedChangeId}
                onSelectBackupServer={setSelectedBackupServerId}
                onSignOut={signOut}
                quota={quota}
                selectedBackupServerId={selectedBackupServerId}
                selectedChangeId={selectedChangeId}
                servers={servers}
                signOutError={signOutError}
                signingOut={signingOut}
                user={user}
              />
            </DesktopWindow>
          );
        })}

      <AllayCompanion
        connectorState={
          health.isError ? "unavailable" : health.data?.status === "ok" ? "connected" : "checking"
        }
        operatorName={firstName(user?.name, user?.email)}
        refreshServers={() => servers.refetch()}
        servers={servers.data?.data}
        serversLoading={servers.isPending}
      />

      <footer className="desktop-taskbar">
        <button className="start-button" onClick={() => open("realms")} type="button">
          <ChevronRight aria-hidden="true" size={16} /> My Realms
        </button>
        <div className="taskbar-apps" aria-label="Open applications" role="toolbar">
          {windows.map((windowState) => {
            const app = apps.find((entry) => entry.id === windowState.appId);
            if (!app) return null;
            const Icon = app.icon;
            return (
              <button
                aria-label={`Switch to ${app.label}`}
                className={!windowState.minimized ? "task-app active" : "task-app"}
                key={windowState.appId}
                onClick={() => focus(windowState.appId)}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
              </button>
            );
          })}
        </div>
        <DesktopClock />
      </footer>

      {session.isPending ? (
        <div className="session-check" role="status">
          Checking account…
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {copiedServerId ? "Server address copied" : ""}
      </span>
    </main>
  );
}
