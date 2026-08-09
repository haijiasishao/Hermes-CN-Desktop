import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webSrc = resolve(import.meta.dirname ?? __dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(webSrc, path), "utf-8");
}

describe("client privacy regression", () => {
  it("removes the anonymous telemetry sender and its tests", () => {
    expect(existsSync(resolve(webSrc, "lib/telemetry.ts"))).toBe(false);
    expect(existsSync(resolve(webSrc, "lib/telemetry.test.ts"))).toBe(false);
  });

  it("does not start telemetry or expose its setting and promo click reporting", () => {
    expect(source("app.tsx")).not.toMatch(/sendTelemetryPingIfDue|VITE_HERMES_TELEMETRY_URL/);
    expect(source("stores/ui.ts")).not.toMatch(/telemetryEnabledAtom|TELEMETRY_ENABLED_UI_KEY/);
    expect(source("routes/settings.tsx")).not.toMatch(/telemetryEnabledAtom|匿名使用统计/);
    expect(source("routes/settings-models-section.tsx")).not.toMatch(/reportPromoClick|@\/lib\/telemetry/);
  });

  it("retains the user-facing local usage analytics route", () => {
    expect(existsSync(resolve(webSrc, "routes/analytics.tsx"))).toBe(true);
  });
});
