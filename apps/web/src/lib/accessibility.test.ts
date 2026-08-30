import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function linearRgb([lightness, chroma, hue]: [number, number, number]) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.min(1, Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    Math.min(1, Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    Math.min(1, Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

function luminance(oklch: [number, number, number]) {
  const [red, green, blue] = linearRgb(oklch);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(left: [number, number, number], right: [number, number, number]) {
  const bright = Math.max(luminance(left), luminance(right));
  const dark = Math.min(luminance(left), luminance(right));
  return (bright + 0.05) / (dark + 0.05);
}

const appRoot = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, appRoot), "utf8");

describe("frontend accessibility invariants", () => {
  test("keeps primary text combinations above WCAG AA contrast", () => {
    const ink: [number, number, number] = [0.25, 0.026, 52];
    const inkSoft: [number, number, number] = [0.39, 0.035, 54];
    const paperRaised: [number, number, number] = [0.975, 0.014, 76];
    const skyInk: [number, number, number] = [0.965, 0.018, 77];
    const earth: [number, number, number] = [0.39, 0.057, 53];
    const clayDeep: [number, number, number] = [0.41, 0.1, 36];
    const warningSurface: [number, number, number] = [0.95, 0.035, 48];

    expect(contrast(ink, paperRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inkSoft, paperRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(skyInk, earth)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(clayDeep, warningSurface)).toBeGreaterThanOrEqual(4.5);
  });

  test("ships visible focus, 44px controls, reduced motion, and responsive height gates", () => {
    const css = source("app/globals.css");
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("outline: 3px solid var(--focus)");
    expect(css).toMatch(/\.topbar-account\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
    expect(css).toMatch(/\.window-controls button\s*\{[\s\S]*?width: 44px;/);
    expect(css).toContain("@media (max-height: 700px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("includes route boundaries and explicit keyboard focus behavior", () => {
    expect(source("app/global-error.tsx")).toContain("No operation was submitted");
    expect(source("app/error.tsx")).toContain("No operation was submitted");
    expect(source("app/not-found.tsx")).toContain("were not changed");
    const desktop = source("components/desktop.tsx");
    expect(desktop).toContain("aria-keyshortcuts");
    expect(desktop).toContain("data-app-window");
    expect(desktop).toContain("tabIndex={-1}");
    const operatorHome = source("components/operator-home.tsx");
    expect(operatorHome).toContain('aria-modal="true"');
    expect(operatorHome).toContain('event.key !== "Tab"');
  });
});
