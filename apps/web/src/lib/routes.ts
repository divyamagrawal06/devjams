export const desktopApps = [
  "servers",
  "review-queue",
  "rule-forge",
  "deployments",
  "backups",
  "account",
] as const;

export type DesktopApp = (typeof desktopApps)[number];

export function isDesktopApp(value: string | null | undefined): value is DesktopApp {
  return typeof value === "string" && (desktopApps as readonly string[]).includes(value);
}

export function desktopRoute(app: DesktopApp): string {
  return `/?app=${encodeURIComponent(app)}`;
}
