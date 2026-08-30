import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import manifest from "../app/manifest";
import { desktopWindowForRoute, isDesktopApp } from "./routes";

const webRoot = join(import.meta.dir, "..", "..");
const serviceWorker = readFileSync(join(webRoot, "public", "sw.js"), "utf8");
const connections = readFileSync(
  join(webRoot, "src", "components", "agent-connections-panel.tsx"),
  "utf8",
);

describe("installable approval inbox safety", () => {
  test("launches the closed live review route", () => {
    const startUrl = new URL(manifest().start_url ?? "", "https://indexd.test");
    const app = startUrl.searchParams.get("app");
    expect(isDesktopApp(app)).toBe(true);
    if (!isDesktopApp(app)) throw new Error("manifest start route is not a desktop app");
    expect(desktopWindowForRoute(app)).toBe("review");
  });

  test("the service worker caches static assets only", () => {
    expect(serviceWorker).toContain("/_next/static/");
    expect(serviceWorker).toContain("/assets/");
    expect(serviceWorker).toContain("/fonts/");
    expect(serviceWorker).not.toContain('startsWith("/api/');
    expect(serviceWorker).not.toContain('startsWith("/v1/');
    expect(serviceWorker).not.toContain('request.mode === "navigate"');
  });

  test("copy-once machine credentials never use browser storage", () => {
    expect(connections).not.toContain("localStorage");
    expect(connections).not.toContain("sessionStorage");
    expect(connections).not.toContain("indexedDB");
  });
});
