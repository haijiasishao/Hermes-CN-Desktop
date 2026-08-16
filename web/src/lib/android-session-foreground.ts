import type { GatewayEvent } from "@hermes/protocol";
import { recordNotificationDebug } from "@/lib/notification-debug";
import { runtime } from "@/lib/runtime";
import { resolvePersistentSessionId } from "@/lib/session-map";
import type {
  AndroidSessionForegroundInput,
  AndroidSessionForegroundState,
} from "@/lib/runtime";

export const ANDROID_SESSION_FOREGROUND_TITLE = "后台链路诊断";

const heartbeatSequences = new Map<string, number>();

// reasoning.delta / message.delta can fire dozens of times per second; every
// event used to emit a separate session_foreground_update IPC (observed as
// 148 ACTION_UPDATE intents within 150 ms in hermes-debug-1786772272797).
// Same-state updates are coalesced to at most one per throttle window; state
// CHANGES (thinking→working, …) and terminal states always pass through so the
// notification never lags a meaningful transition.
const FGS_UPDATE_THROTTLE_MS = 1_000;
const FGS_THROTTLABLE_STATES = new Set(["thinking", "working"]);
const lastStateSentAt = new Map<string, { state: string; tsMs: number }>();

/**
 * Pure throttle decision for same-state update floods. Returns true when the
 * candidate update is a repeat of the last emitted state within the throttle
 * window and should be skipped.
 */
export function shouldThrottleSessionForegroundUpdate(input: {
  persistentSessionId: string | undefined;
  state: string;
  timestampMs: number;
  last?: { state: string; tsMs: number };
}): boolean {
  const { persistentSessionId, state, timestampMs, last } = input;
  if (!persistentSessionId) return false;
  if (!FGS_THROTTLABLE_STATES.has(state)) return false;
  if (!last || last.state !== state) return false;
  if (timestampMs - last.tsMs < FGS_UPDATE_THROTTLE_MS) return true;
  return false;
}

function recordFgsUpdateState(sessionId: string, state: string, tsMs: number): void {
  lastStateSentAt.set(sessionId, { state, tsMs });
}

function withMonotonicHeartbeatSequence(
  input: AndroidSessionForegroundInput,
): AndroidSessionForegroundInput {
  const requested = Number.isFinite(input.heartbeatSequence)
    ? Math.max(0, Math.floor(input.heartbeatSequence))
    : 0;
  const previous = heartbeatSequences.get(input.persistentSessionId);
  const heartbeatSequence = previous === undefined
    ? requested
    : Math.max(previous + 1, requested);
  heartbeatSequences.set(input.persistentSessionId, heartbeatSequence);
  return {
    ...input,
    title: ANDROID_SESSION_FOREGROUND_TITLE,
    heartbeatSequence,
  };
}

/**
 * Map only gateway lifecycle events that describe the active turn. Keeping
 * this function pure makes the notification state contract testable without a
 * WebView or native bridge.
 */

/**
 * Normalize the session id passed to the native FGS bridge. The bridge
 * contract requires a PERSISTENT session id (e.g. 20260814_233534_67bcfc);
 * a raw gateway id (e.g. dae122d5) would make SessionForegroundService's
 * stop/update matching fail because the id rotates across reconnects.
 * Callers may hold either shape (route params, event session_id,
 * session.create results), so resolve to the persistent id when the
 * session-map knows the mapping, and fall back to the input unchanged.
 */
function normalizePersistentSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return resolvePersistentSessionId(sessionId) ?? sessionId;
}
export function foregroundStateForGatewayEvent(
  event: GatewayEvent,
): AndroidSessionForegroundState | undefined {
  switch (event.type) {
    case "message.start":
    case "message.delta":
    case "thinking":
    case "thinking.delta":
    case "reasoning":
    case "reasoning.delta":
    case "reasoning.available":
      return "thinking";
    case "tool.generating":
    case "tool.start":
      return "working";
    case "tool.complete":
      return "thinking";
    case "approval.request":
      return "waiting_approval";
    case "gateway.disconnected":
      return "reconnecting";
    case "message.complete":
      return "completed";
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

export async function startAndroidSessionForeground(input: AndroidSessionForegroundInput): Promise<void> {
  if (!runtime.androidRemoteOnly || !window.hermesDesktop?.sessionForegroundStart) return;
  const normalized = { ...input, persistentSessionId: normalizePersistentSessionId(input.persistentSessionId) ?? input.persistentSessionId };
  const request = withMonotonicHeartbeatSequence(normalized);
  try {
    const result = await window.hermesDesktop.sessionForegroundStart(request);
    recordNotificationDebug("session-fgs.started", {
      sessionId: request.persistentSessionId,
      sequence: request.heartbeatSequence,
      state: request.state,
      ts: request.timestampMs,
      supported: result.supported,
      normalizedFrom: input.persistentSessionId,
    });
  } catch (error) {
    recordNotificationDebug("session-fgs.start-failed", {
      sessionId: request.persistentSessionId,
      state: request.state,
      errorCategory: error instanceof Error ? "ipc_error" : "unknown_error",
      ts: Date.now(),
    }, "warn");
  }
}

export async function updateAndroidSessionForeground(input: AndroidSessionForegroundInput): Promise<void> {
  if (!runtime.androidRemoteOnly || !window.hermesDesktop?.sessionForegroundUpdate) return;
  const normalized = { ...input, persistentSessionId: normalizePersistentSessionId(input.persistentSessionId) ?? input.persistentSessionId };
  const tsMs = input.timestampMs ?? Date.now();
  const throttled = shouldThrottleSessionForegroundUpdate({
    persistentSessionId: normalized.persistentSessionId,
    state: input.state,
    timestampMs: tsMs,
    last: lastStateSentAt.get(normalized.persistentSessionId),
  });
  if (throttled) {
    recordNotificationDebug("session-fgs.throttled", {
      sessionId: normalized.persistentSessionId,
      state: input.state,
      ts: tsMs,
    });
    return;
  }
  recordFgsUpdateState(normalized.persistentSessionId, input.state, tsMs);
  input = withMonotonicHeartbeatSequence(normalized);
  try {
    const result = await window.hermesDesktop.sessionForegroundUpdate(input);
    recordNotificationDebug("session-fgs.updated", {
      sessionId: input.persistentSessionId,
      sequence: input.heartbeatSequence,
      state: input.state,
      ts: input.timestampMs,
      supported: result.supported,
      normalizedFrom: normalized.persistentSessionId,
    });
  } catch (error) {
    recordNotificationDebug("session-fgs.update-failed", {
      sessionId: input.persistentSessionId,
      sequence: input.heartbeatSequence,
      state: input.state,
      errorCategory: error instanceof Error ? "ipc_error" : "unknown_error",
      ts: Date.now(),
    }, "warn");
  }
}

export async function stopAndroidSessionForeground(persistentSessionId: string): Promise<void> {
  if (!runtime.androidRemoteOnly || !window.hermesDesktop?.sessionForegroundStop) return;
  const normalized = normalizePersistentSessionId(persistentSessionId) ?? persistentSessionId;
  try {
    console.error(`[FGS-DIAG] stopAndroidSessionForeground called sessionId=${normalized} (raw=${persistentSessionId}) at=${Date.now()}`, new Error().stack);
    await window.hermesDesktop.sessionForegroundStop({ persistentSessionId: normalized });
    recordNotificationDebug("session-fgs.stopped", { sessionId: normalized, ts: Date.now() });
  } catch {
    recordNotificationDebug("session-fgs.stop-failed", { sessionId: normalized, ts: Date.now() }, "warn");
  }
}
