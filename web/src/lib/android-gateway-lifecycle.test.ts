/**
 * Regression: Gateway lifecycle host must stay mounted across route changes.
 *
 * Before this fix, navigating away from /tasks/:id (DetailRoute) to
 * /notifications while a task was running caused the last useGateway()
 * subscriber to unmount. The cleanup in subscribeGateway removed all event
 * listeners and disabled auto-reconnect, so the next prompt reported
 * "session not found".
 *
 * The fix adds a persistent, headless GatewayLifecycleHost component in
 * BackendApp (app.tsx) that calls useGateway() and renders null, ensuring
 * at least one subscriber remains alive during Settings/Notifications visits.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname ?? __dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf-8");

describe("Android gateway lifecycle host", () => {
  const appSource = read("web/src/app.tsx");

  it("defines a GatewayLifecycleHost component that calls useGateway", () => {
    // The component must exist as a named function
    expect(appSource).toMatch(/function\s+GatewayLifecycleHost\s*\(\s*\)/);
    // It must call useGateway() to keep the subscription alive
    expect(appSource).toMatch(/GatewayLifecycleHost[\s\S]{1,200}useGateway\(\)/);
  });

  it("renders null so the host is invisible to the DOM", () => {
    // Between the component opening and the closing brace, it must return null
    expect(appSource).toMatch(
      /function\s+GatewayLifecycleHost\s*\(\s*\)[\s\S]{0,300}return\s+null/,
    );
  });

  it("mounts GatewayLifecycleHost inside BackendApp outside Routes", () => {
    // The host must be a sibling of AppShell/ProfileSwitchOverlay/etc,
    // NOT inside <Routes>. This ensures it persists across route changes.
    // Assert: <GatewayLifecycleHost /> appears after the </Routes> closing tag
    // and before the </> fragment close of BackendApp.
    const routesCloseIdx = appSource.lastIndexOf("</Routes>");
    expect(routesCloseIdx).toBeGreaterThan(0);

    const hostUsageIdx = appSource.indexOf("<GatewayLifecycleHost");
    expect(hostUsageIdx).toBeGreaterThan(routesCloseIdx);
  });

  it("imports useGateway from the hooks module", () => {
    expect(appSource).toContain('import { useGateway } from "@/hooks/use-gateway"');
  });

  it("subscribeGateway tears down when last subscriber unmounts (baseline contract)", () => {
    // This asserts the root cause remains guarded: the cleanup that removes
    // listeners and disables auto-reconnect exists. Without the persistent host,
    // this cleanup fires when DetailRoute unmounts.
    const hookSource = read("web/src/hooks/use-gateway.ts");
    expect(hookSource).toContain("if (bridge.subscribers.length === 0");
    expect(hookSource).toContain("getGatewayClient().disableAutoReconnect()");
  });
});
