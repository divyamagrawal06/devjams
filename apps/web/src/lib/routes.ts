export const desktopApps = [
  "servers",
  "review-queue",
  "rule-forge",
  "deployments",
  "backups",
  "account",
] as const;

export type DesktopApp = (typeof desktopApps)[number];
export type DesktopWindowId = "realms" | "review" | "forge" | "activity" | "backups" | "account";

const desktopWindowByRoute: Record<DesktopApp, DesktopWindowId> = {
  servers: "realms",
  "review-queue": "review",
  "rule-forge": "forge",
  deployments: "activity",
  backups: "backups",
  account: "account",
};

export function isDesktopApp(value: string | null | undefined): value is DesktopApp {
  return typeof value === "string" && (desktopApps as readonly string[]).includes(value);
}

export function desktopRoute(app: DesktopApp): string {
  return `/?app=${encodeURIComponent(app)}`;
}

export function desktopWindowForRoute(app: DesktopApp): DesktopWindowId {
  return desktopWindowByRoute[app];
}
