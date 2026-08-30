import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { desktopApps, desktopRoute, isDesktopApp } from "./routes";

const appRoot = join(import.meta.dir, "..", "app");

describe("canonical web routes", () => {
  test("ships the authenticated desktop and connector routes from apps/web", () => {
    const requiredRoutes = [
      "page.tsx",
      join("api", "auth", "[...all]", "route.ts"),
      join("api", "farlands", "[...path]", "route.ts"),
      join("v1", "[[...path]]", "route.ts"),
    ];

    for (const route of requiredRoutes) {
      expect(existsSync(join(appRoot, route))).toBe(true);
    }
  });

  test("keeps every desktop deep-link value closed and round-trippable", () => {
    for (const app of desktopApps) {
      expect(isDesktopApp(app)).toBe(true);
      expect(desktopRoute(app)).toBe(`/?app=${app}`);
    }
    expect(isDesktopApp("cluster-admin")).toBe(false);
  });
});
