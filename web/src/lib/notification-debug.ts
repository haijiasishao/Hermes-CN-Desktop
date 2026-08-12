import { debugBus } from "@/lib/debug-bus";
import { runtime } from "@/lib/runtime";

export type NotificationDebugLevel = "info" | "warn" | "error";

/**
 * Record notification/reconnect diagnostics in the exported debug bus.
 *
 * Keep this Android-only and deliberately structural: debug archives may be
 * shared outside the device, so callers must pass counts/status/timing rather
 * than assistant or user message text, tokens, or full response bodies.
 */
export function recordNotificationDebug(
  stage: string,
  payload: Record<string, unknown> = {},
  level: NotificationDebugLevel = "info",
): void {
  if (!runtime.androidRemoteOnly) return;
  debugBus.push({
    type: "gateway",
    level,
    summary: `notification.${stage}`,
    payload,
  });
}
