import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as { window?: unknown }).window;
});

describe("legacy anonymous telemetry cleanup", () => {
  it("removes only the three legacy telemetry keys", async () => {
    const uiStore = await import("./ui-store");
    uiStore.__resetUiStoreForTests({
      "hermes.telemetry-device-id": "device-id",
      "hermes.telemetry-enabled": true,
      "hermes.telemetry-last-ping-at": 123,
      "hermes.notify-system": true,
    });
    const { clearLegacyTelemetryState } = await import("./privacy-migration");

    clearLegacyTelemetryState();

    expect(uiStore.readUiValue("hermes.telemetry-device-id", null)).toBeNull();
    expect(uiStore.readUiValue("hermes.telemetry-enabled", null)).toBeNull();
    expect(uiStore.readUiValue("hermes.telemetry-last-ping-at", null)).toBeNull();
    expect(uiStore.readUiValue("hermes.notify-system", false)).toBe(true);
  });
});
