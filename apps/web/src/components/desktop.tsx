"use client";

import { useQuery } from "@tanstack/react-query";
import { motion, type PanInfo, useDragControls, useReducedMotion } from "framer-motion";
import {
  Archive,
  ChevronRight,
  CircleAlert,
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
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOnlineStatus } from "@/app/providers";
import { api, type LiveListResponse, type QuotaResponse } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { type ConnectorState, evaluateControlTruth } from "@/lib/control-truth";
import { desktopWindowForRoute, isDesktopApp } from "@/lib/routes";
import { PanoramaBackground } from "./panorama-background";

function WindowLoading() {
  return (
    <div className="window-loading" role="status">
      Loading workspace…
    </div>
  );
}

const BackupsWindow = dynamic(
  () => import("./backups-window").then((module) => module.BackupsWindow),
  { loading: WindowLoading },
);
const AllayCompanion = dynamic(
  () => import("./allay-companion").then((module) => module.AllayCompanion),
  { loading: () => null },
);
const BillingPanel = dynamic(
  () => import("./billing-panel").then((module) => module.BillingPanel),
  { loading: WindowLoading },
);
const OperatorHome = dynamic(
  () => import("./operator-home").then((module) => module.OperatorHome),
  { loading: WindowLoading },
);
const ReviewQueueWindow = dynamic(
  () => import("./review-queue-window").then((module) => module.ReviewQueueWindow),
  { loading: WindowLoading },
);
const RuleForgeWindow = dynamic(
  () => import("./rule-forge-window").then((module) => module.RuleForgeWindow),
  { loading: WindowLoading },
);
const TrustLedgerWindow = dynamic(
  () => import("./trust-ledger-window").then((module) => module.TrustLedgerWindow),
  { loading: WindowLoading },
);

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
    const query = window.matchMedia("(max-width: 760px), (max-height: 700px)");
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

type WindowBodyProps = {
  appId: AppId;
  connectorState: ConnectorState;
  controlMessage: string;
  controlsAvailable: boolean;
  health: ReturnType<typeof useQuery<HealthResponse>>;
  onOpenBackups: (serverId: string) => void;
  onOpenReview: (changeId: string) => void;
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
  connectorState,
  controlMessage,
  controlsAvailable,
  health,
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
    return (
      <OperatorHome
        connectorState={connectorState}
        onOpenRecovery={onOpenBackups}
        operatorName={firstName(user?.name, user?.email)}
        quota={quota.data?.data ?? null}
        quotaError={quota.isError}
        quotaPending={quota.isPending}
        refreshQuota={() => quota.refetch()}
        refreshServers={() => servers.refetch()}
        servers={servers.data?.data ?? []}
        serversError={servers.isError}
        serversObservedAt={servers.dataUpdatedAt}
        serversPending={servers.isPending}
      />
    );
  }

  if (appId === "backups") {
    return (
      <BackupsWindow
        controlMessage={controlMessage}
        controlsAvailable={controlsAvailable}
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
      <ReviewQueueWindow
        controlMessage={controlMessage}
        controlsAvailable={controlsAvailable}
        onSelectChange={onSelectChange}
        selectedChangeId={selectedChangeId}
      />
    );
  }

  if (appId === "forge") {
    return (
      <RuleForgeWindow
        controlMessage={controlMessage}
        controlsAvailable={controlsAvailable}
        onOpenReview={onOpenReview}
        servers={servers.data?.data ?? []}
      />
    );
  }

  if (appId === "activity") {
    return (
      <TrustLedgerWindow
        controlMessage={controlMessage}
        controlsAvailable={controlsAvailable}
        servers={servers.data?.data ?? []}
      />
    );
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
                <Server aria-hidden="true" size={17} /> Workloads
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

      <BillingPanel controlMessage={controlMessage} controlsAvailable={controlsAvailable} />

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
  registerWindow,
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
  registerWindow: (node: HTMLElement | null) => void;
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
      data-app-window={app.id}
      drag={!windowState.maximized && !compact}
      dragControls={dragControls}
      dragElastic={0}
      dragListener={false}
      dragMomentum={false}
      initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 }}
      onDragEnd={(_event, info) => onDragEnd(info)}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
      ref={registerWindow}
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
      tabIndex={-1}
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
  const [hydrated, setHydrated] = useState(false);
  const user = hydrated ? (session.data?.user ?? null) : null;
  const compact = useCompactViewport();
  const online = useOnlineStatus();
  const [now, setNow] = useState(() => Date.now());
  const [windows, setWindows] = useState<WindowState[]>(initialWindows);
  const [selectedBackupServerId, setSelectedBackupServerId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const windowRefs = useRef(new Map<AppId, HTMLElement>());
  const iconRefs = useRef(new Map<AppId, HTMLButtonElement>());
  const taskbarRefs = useRef(new Map<AppId, HTMLButtonElement>());

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);

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

  const rawConnectorState: ConnectorState = health.isError
    ? "unavailable"
    : health.data?.status === "ok"
      ? "connected"
      : "checking";
  const controlTruth = evaluateControlTruth({
    connectorState: rawConnectorState,
    now,
    observedAt: servers.dataUpdatedAt,
    online,
  });
  const connectorState: ConnectorState =
    controlTruth.state === "verified"
      ? "connected"
      : controlTruth.state === "checking"
        ? "checking"
        : "unavailable";

  const apps = useMemo<AppDefinition[]>(() => {
    const realmCount = servers.data?.data.length;
    return [
      {
        id: "realms",
        label: "Operator Home",
        detail:
          realmCount === undefined
            ? "Checking…"
            : `${realmCount} ${realmCount === 1 ? "workload" : "workloads"}`,
        icon: Server,
        color: "oklch(0.55 0.09 54)",
      },
      {
        id: "backups",
        label: "Recovery Center",
        detail: realmCount === 0 ? "No workloads" : "Snapshots and rollback",
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

  const focusWindowElement = useCallback((appId: AppId) => {
    window.requestAnimationFrame(() => windowRefs.current.get(appId)?.focus());
  }, []);

  const focus = useCallback(
    (appId: AppId, moveKeyboardFocus = true) => {
      setWindows((items) =>
        items.map((item) =>
          item.appId === appId ? { ...item, z: nextWindowZ(items), minimized: false } : item,
        ),
      );
      if (moveKeyboardFocus) focusWindowElement(appId);
    },
    [focusWindowElement],
  );

  const open = useCallback(
    (appId: AppId) => {
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
      focusWindowElement(appId);
    },
    [focusWindowElement],
  );

  const openBackups = useCallback(
    (serverId?: string) => {
      if (serverId) {
        setSelectedBackupServerId(serverId);
      } else if (!selectedBackupServerId && servers.data?.data[0]) {
        setSelectedBackupServerId(servers.data.data[0].id);
      }
      open("backups");
    },
    [open, selectedBackupServerId, servers.data?.data],
  );

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const index = Number(event.key) - 1;
      const app = apps[index];
      if (!app) return;
      event.preventDefault();
      if (app.id === "backups") openBackups();
      else open(app.id);
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [apps, open, openBackups]);

  const openReview = (changeId: string) => {
    setSelectedChangeId(changeId);
    open("review");
  };

  const close = (appId: AppId) => {
    setWindows((items) => items.filter((item) => item.appId !== appId));
    window.requestAnimationFrame(() => iconRefs.current.get(appId)?.focus());
  };

  const minimize = (appId: AppId) => {
    setWindows((items) =>
      items.map((item) => (item.appId === appId ? { ...item, minimized: true } : item)),
    );
    window.requestAnimationFrame(() => taskbarRefs.current.get(appId)?.focus());
  };

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
  const connectorStatus =
    controlTruth.state !== "verified"
      ? controlTruth.message
      : health.data?.status === "ok"
        ? totalCount === undefined
          ? "Control plane connected"
          : totalCount === 0
            ? "Connected, no workloads yet"
            : `${runningCount} of ${totalCount} workloads running`
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
            {controlTruth.state !== "verified" ? (
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
              aria-keyshortcuts={`Control+Alt+${apps.indexOf(app) + 1}`}
              onClick={() => (app.id === "backups" ? openBackups() : open(app.id))}
              ref={(node) => {
                if (node) iconRefs.current.set(app.id, node);
                else iconRefs.current.delete(app.id);
              }}
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
              onFocus={() => focus(windowState.appId, false)}
              onMinimize={() => minimize(windowState.appId)}
              onToggleMaximize={() => toggleMaximize(windowState.appId)}
              registerWindow={(node) => {
                if (node) windowRefs.current.set(windowState.appId, node);
                else windowRefs.current.delete(windowState.appId);
              }}
              windowState={windowState}
            >
              <WindowBody
                appId={windowState.appId}
                connectorState={connectorState}
                controlMessage={controlTruth.message}
                controlsAvailable={controlTruth.canMutate}
                health={health}
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
        connectorState={connectorState}
        controlMessage={controlTruth.message}
        operatorName={firstName(user?.name, user?.email)}
        refreshServers={async () => {
          const result = await servers.refetch();
          if (result.isError || result.fetchStatus === "paused") return undefined;
          return result.data?.data;
        }}
        servers={servers.data?.data}
        serversLoading={servers.isPending}
      />

      <footer className="desktop-taskbar">
        <button className="start-button" onClick={() => open("realms")} type="button">
          <ChevronRight aria-hidden="true" size={16} /> Operator Home
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
                ref={(node) => {
                  if (node) taskbarRefs.current.set(windowState.appId, node);
                  else taskbarRefs.current.delete(windowState.appId);
                }}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
              </button>
            );
          })}
        </div>
        <DesktopClock />
      </footer>

      {hydrated && session.isPending ? (
        <div className="session-check" role="status">
          Checking account…
        </div>
      ) : null}
    </main>
  );
}
