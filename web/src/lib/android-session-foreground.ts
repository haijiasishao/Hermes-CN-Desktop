import { recordNotificationDebug } from "@/lib/notification-debug";
import { runtime } from "@/lib/runtime";
import type { AndroidSessionForegroundInput } from "@/lib/runtime";

export async function startAndroidSessionForeground(input: AndroidSessionForegroundInput): Promise<void> {
  if (!runtime.androidRemoteOnly || !window.hermesDesktop?.sessionForegroundStart) return;
  try {
    const result = await window.hermesDesktop.sessionForegroundStart(input);
    recordNotificationDebug("session-fgs.started", {
      sessionId: input.persistentSessionId,
      sequence: input.heartbeatSequence,
      ts: input.timestampMs,
      supported: result.supported,
    });
  } catch (error) {
    recordNotificationDebug("session-fgs.start-failed", {
      sessionId: input.persistentSessionId,
      errorCategory: error instanceof Error ? "ipc_error" : "unknown_error",
      ts: Date.now(),
    }, "warn");
  }
}

export async function stopAndroidSessionForeground(persistentSessionId: string): Promise<void> {
  if (!runtime.androidRemoteOnly || !window.hermesDesktop?.sessionForegroundStop) return;
  try {
    await window.hermesDesktop.sessionForegroundStop({ persistentSessionId });
    recordNotificationDebug("session-fgs.stopped", { sessionId: persistentSessionId, ts: Date.now() });
  } catch {
    recordNotificationDebug("session-fgs.stop-failed", { sessionId: persistentSessionId, ts: Date.now() }, "warn");
  }
}
