/**
 * Reconnect-driven session re-attach.
 *
 * The desktop gateway (Hermes dashboard) has NO socket-level replay/resume and
 * NO server-side event buffer: when the event stream drops (laptop sleep/wake,
 * dashboard restart, flaky network) the backend session keeps running but is
 * orphaned from the dead transport and gets reaped after a grace window.
 * Recovery is purely application-level — after the transport reconnects we must
 * re-issue `session.resume` so the server re-pins the live turn to the new
 * socket and the remaining deltas stream onto the SAME assistant message.
 *
 * Without this, a mid-turn drop loses the reply (the classic "回复要切走再切回来
 * 才看得见" / frozen "连接已断开" symptom). This mirrors the official desktop's
 * use-gateway-boot + use-session-actions behavior.
 *
 * Kept as a pure, dependency-injected function so it is unit-testable without
 * the jotai store / gateway-client singletons. See
 * docs/gateway-connection-overhaul.md (C2).
 */
export interface ReconnectResumeResult {
  session_id: string;
  resumed?: string;
}

export interface ReattachDiagnostic {
  stage:
    | "reattach.started"
    | "reattach.no_active_session"
    | "reattach.active_session"
    | "reattach.resume_requested"
    | "reattach.resumed"
    | "reattach.failed";
  details?: Record<string, unknown>;
}

export interface ReattachAfterReconnectDeps {
  /** The currently active gateway session id, or null/undefined if none is open. */
  getActiveSessionId: () => string | null | undefined;
  /** Map a (possibly stale) gateway session id to its persistent session id. */
  resolvePersistentId: (sessionId: string) => string;
  /** Issue `session.resume` for the given persistent id. */
  resume: (persistentId: string) => Promise<ReconnectResumeResult>;
  /** Called on success with the (possibly new) gateway id + the persistent id. */
  onResumed: (gatewaySessionId: string, persistentId: string) => void;
  /** Called when resume rejects or yields no session (session gone) so the caller can surface an error. */
  onResumeFailed: (error: unknown) => void;
  /** Optional non-fatal lifecycle diagnostics for Android debug bundles. */
  onDiagnostic?: (event: ReattachDiagnostic) => void;
  /**
   * Called at the start of reattach — before the active-session check and
   * before `session.resume` is issued. The promise is awaited so a completed
   * Android background turn can retire its stale local runtime before we
   * decide whether a live session still needs to be resumed.
   */
  onReattachStart?: () => void | Promise<void>;
}

/** Only explicit server-side absence is terminal; timeouts are recoverable. */
export function isDefinitiveMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:session|conversation).*(?:not found|does not exist|unknown|gone|reaped)/i.test(message)
    || /(?:not found|does not exist|unknown|gone|reaped).*(?:session|conversation)/i.test(message);
}

function reportDiagnostic(
  deps: ReattachAfterReconnectDeps,
  event: ReattachDiagnostic,
): void {
  try {
    deps.onDiagnostic?.(event);
  } catch {
    // Diagnostics must never alter reconnect behavior.
  }
}

export async function reattachAfterReconnect(deps: ReattachAfterReconnectDeps): Promise<void> {
  reportDiagnostic(deps, { stage: "reattach.started" });
  // Notify the caller before any active-session gating or resume. Awaiting the
  // callback prevents a completed background turn from racing session.resume.
  // On Android the REST message snapshot is the ONLY way to retire a stale
  // "思考中" indicator when the backend finished while the app was backgrounded,
  // so this must fire immediately — not after the (potentially slow) resume.
  await deps.onReattachStart?.();

  const activeSessionId = deps.getActiveSessionId();
  // Nothing open to re-pin — a fresh connect with no session is a no-op.
  if (!activeSessionId) {
    reportDiagnostic(deps, { stage: "reattach.no_active_session" });
    return;
  }

  const persistentId = deps.resolvePersistentId(activeSessionId);
  reportDiagnostic(deps, {
    stage: "reattach.active_session",
    details: {
      gatewaySessionId: activeSessionId,
      persistentSessionId: persistentId,
    },
  });
  reportDiagnostic(deps, {
    stage: "reattach.resume_requested",
    details: { persistentSessionId: persistentId },
  });
  try {
    const result = await deps.resume(persistentId);
    if (!result?.session_id) {
      const error = new Error("session.resume returned no session_id");
      reportDiagnostic(deps, {
        stage: "reattach.failed",
        details: { persistentSessionId: persistentId, error: error.message },
      });
      deps.onResumeFailed(error);
      return;
    }
    deps.onResumed(result.session_id, result.resumed ?? persistentId);
    reportDiagnostic(deps, {
      stage: "reattach.resumed",
      details: {
        gatewaySessionId: result.session_id,
        persistentSessionId: result.resumed ?? persistentId,
      },
    });
  } catch (error) {
    reportDiagnostic(deps, {
      stage: "reattach.failed",
      details: {
        persistentSessionId: persistentId,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
    });
    deps.onResumeFailed(error);
  }
}
