import { removeUiValue } from "./ui-store";

const LEGACY_TELEMETRY_KEYS = [
  "hermes.telemetry-device-id",
  "hermes.telemetry-enabled",
  "hermes.telemetry-last-ping-at",
] as const;

/** Remove identifiers and scheduling state left by the retired telemetry client. */
export function clearLegacyTelemetryState(): void {
  for (const key of LEGACY_TELEMETRY_KEYS) removeUiValue(key);
}
