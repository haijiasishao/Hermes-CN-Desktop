// Session "tip" redirects (issue #305).
//
// Auto-compression rotates a conversation onto a fresh continuation session in
// the backend. When the UI resumes a pre-compression id, the gateway follows
// the compression chain and answers with the live continuation in
// `session.resume`'s `resumed` field — a DIFFERENT persistent id than the one
// we asked for. If the detail route stays pinned to the old id, the user sees
// the conversation "vanish" (its messages have moved to the tip) while a
// duplicate `#2/#3` tip appears in the sidebar.
//
// These pure helpers record that redirect and decide when the route should
// project onto the new tip. They are intentionally free of React/Jotai so the
// decision is unit-testable in isolation; the reactive plumbing lives in the
// `sessionTipRedirectAtom` and the detail route effect.

export type TipRedirectMap = Record<string, string>;

/**
 * Record that a `session.resume` on `requestedId` was redirected by the backend
 * to the live continuation `resumedId`. Returns the same map reference when
 * there is nothing new to record (no resumed id, an identity redirect, or an
 * entry that already matches) so callers can skip redundant state updates.
 */
export function recordTipRedirect(
  prev: TipRedirectMap,
  requestedId: string | undefined,
  resumedId: string | undefined,
): TipRedirectMap {
  if (!requestedId || !resumedId || resumedId === requestedId) return prev;
  if (prev[requestedId] === resumedId) return prev;
  return { ...prev, [requestedId]: resumedId };
}

/**
 * Record the detail-route projection needed after an Android reconnect snapshot
 * retires a completed turn. The gateway id is ephemeral, so the route must
 * follow the persistent id before the gateway-to-session map is cleaned up.
 */
export function recordCompletedSnapshotRouteRedirect(
  prev: TipRedirectMap,
  input: {
    snapshotCompleted: boolean;
    gatewaySessionId?: string | null;
    persistentSessionId?: string | null;
  },
): TipRedirectMap {
  if (!input.snapshotCompleted) return prev;
  return recordTipRedirect(
    prev,
    input.gatewaySessionId ?? undefined,
    input.persistentSessionId ?? undefined,
  );
}

/**
 * Given the current route ids, return the tip the detail route should project
 * onto, or `null` when it is already on the tip or there is no redirect. Never
 * returns a tip equal to the current `taskId`, so re-running the effect after
 * a successful redirect is a no-op (no navigation loop).
 *
 * The historical `activeSessionId` guard is deliberately dropped: after a
 * background reconnect the completed-snapshot branch prunes the
 * gateway→persistent map AND records the redirect, but the sidebar atom may
 * already hold the persistent id. Requiring `tip !== activeSessionId` there
 * returned null and left the URL pinned to the dead gateway id — history REST
 * 404s and the next send resumes the ephemeral id (`session not found`,
 * hermes-debug-1786751599120).
 */
export function pickTipRedirect(
  redirects: TipRedirectMap,
  ids: {
    taskId?: string | null;
    restSessionId?: string | null;
    activeSessionId?: string | null;
  },
): string | null {
  const { taskId, restSessionId } = ids;
  for (const from of [taskId, restSessionId]) {
    if (!from) continue;
    const tip = redirects[from];
    if (tip && tip !== taskId) return tip;
  }
  return null;
}
