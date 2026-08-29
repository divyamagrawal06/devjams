const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function connectorPathAllowed(pathname: string): boolean {
  if (pathname === "/api/servers/internal" || pathname.startsWith("/api/servers/internal/")) {
    return false;
  }

  return (
    pathname === "/health" ||
    pathname === "/api/servers" ||
    pathname.startsWith("/api/servers/") ||
    pathname === "/api/quota" ||
    pathname.startsWith("/api/quota/") ||
    pathname === "/api/billing" ||
    pathname === "/api/billing/checkout" ||
    pathname === "/api/billing/portal" ||
    pathname === "/api/rules" ||
    pathname.startsWith("/api/rules/")
  );
}

type OriginPolicy = {
  method: string;
  origin: string | null;
  requestOrigin: string;
  configuredOrigin?: string;
  production: boolean;
};

export function connectorOriginAllowed({
  method,
  origin,
  requestOrigin,
  configuredOrigin,
  production,
}: OriginPolicy): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!origin) return false;

  const allowed = new Set([
    requestOrigin,
    "https://www.indexd.app",
    "https://indexd.app",
    ...(!production ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
  ]);

  if (configuredOrigin) allowed.add(configuredOrigin);
  return allowed.has(origin);
}
