import { useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  gwSessionIdAtom,
  type ChatRuntimeBySession,
  type ChatSessionRuntime,
} from "@/stores/chat";
import { isRuntimeRunning } from "@/lib/session-activity";
import {
  isPersistentSessionShape,
  resolveGatewaySessionId,
  resolvePersistentSessionId,
} from "@/lib/session-map";

export interface SessionResolution {
  restSessionId: string | undefined;
  activeMappedGatewaySessionId: string | undefined;
  runtimeSessionId: string | undefined;
  usageGatewaySessionId: string | undefined;
  runtime: ChatSessionRuntime;
  runtimeIsBusy: boolean;
  isGatewayLinked: boolean;
  isLiveSession: boolean;
}

export interface GatewaySessionTarget {
  gatewaySessionId: string;
  resumePersistentSessionId?: string;
}

// Decide which id a send should target. A route can retain an old gateway id
// after reconnect cleanup, while its REST lookup still resolves to the
// persistent session. In that case the persistent id must be resumed before
// sending; a live mapped gateway id remains authoritative when present.
//
// Safety rule: NEVER submit through a raw ephemeral id. When the route id is
// not the persistent shape and resolution failed (map pruned by reconnect),
// the only valid target is the active persistent session — submitting the
// ephemeral id yields `session not found` (hermes-debug-1786751599120).
export function resolveGatewaySessionTarget(params: {
  taskId: string;
  restSessionId: string | undefined;
  activeMappedGatewaySessionId: string | undefined;
  activePersistentSessionId?: string | undefined;
}): GatewaySessionTarget {
  if (params.activeMappedGatewaySessionId) {
    return { gatewaySessionId: params.activeMappedGatewaySessionId };
  }
  if (params.restSessionId) {
    return {
      gatewaySessionId: params.restSessionId,
      resumePersistentSessionId: params.restSessionId,
    };
  }
  // traceable persistent fallback: the route id was an ephemeral gateway id
  // whose mapping vanished (or a bare unknown id). Resume the last known
  // persistent session instead of submitting the dead id.
  if (params.activePersistentSessionId) {
    return {
      gatewaySessionId: params.activePersistentSessionId,
      resumePersistentSessionId: params.activePersistentSessionId,
    };
  }
  return { gatewaySessionId: params.taskId };
}

// Pure so it can be unit-tested without React. Decides which runtime bucket the
// detail view should render for `taskId`.
export function resolveSessionRuntime(
  taskId: string | undefined,
  gwSessionId: string | null,
  runtimeBySession: ChatRuntimeBySession,
): SessionResolution {
  // REST detail/messages must ONLY ever see the persistent form. When the map
  // is intact this resolves the gateway→persistent alias; when the map was
  // pruned by a reconnect the raw taskId would fall back to the gateway id and
  // /api/sessions/{id} answers 404 (`session not found` on the history pane
  // after background recovery). If the route id is not already the persistent
  // shape and cannot be resolved, drop it so callers resume/redirect instead
  // of issuing a doomed REST request (hermes-debug-1786751599120).
  const resolvedRestId = taskId ? resolvePersistentSessionId(taskId) : undefined;
  const restSessionId =
    resolvedRestId && isPersistentSessionShape(resolvedRestId) ? resolvedRestId : undefined;

  // The live gateway session is the ground truth for what is streaming *right
  // now*. When it belongs to the same persistent session this route is showing,
  // prefer it directly. One persistent id can map to several gateway ids, so the
  // reverse lookup (resolveGatewaySessionId) is ambiguous, but the forward
  // lookup off the live id is not. Trusting the live id keeps the optimistic
  // user message + streaming assistant reading from the bucket the send wrote
  // into, instead of an orphaned empty runtime — even if the map is still dirty.
  const liveGatewaySessionId =
    gwSessionId && resolvePersistentSessionId(gwSessionId) === restSessionId
      ? gwSessionId
      : undefined;
  // A SEND target must be a gateway session minted by the CURRENT socket era.
  // Mappings that survived from a previous connection point at gateway
  // sessions the server has reaped; a prompt.submit to them fails with
  // `session not found`. So only the live gateway id is ever an active send
  // target — when it does not belong to this task the caller must resume the
  // persistent id instead of reusing a stale mapped id. (resolveGatewaySessionId
  // remains valid for READ-side bucket lookup below.)
  const activeMappedGatewaySessionId = liveGatewaySessionId ?? undefined;
  const mappedGatewaySessionIdForRead = resolveGatewaySessionId(taskId);
  const runtimeSessionId = (() => {
    if (taskId && runtimeBySession[taskId]) return taskId;
    if (activeMappedGatewaySessionId && runtimeBySession[activeMappedGatewaySessionId]) {
      return activeMappedGatewaySessionId;
    }
    if (mappedGatewaySessionIdForRead && runtimeBySession[mappedGatewaySessionIdForRead]) {
      return mappedGatewaySessionIdForRead;
    }
    return undefined;
  })();
  const runtime = taskId
    ? runtimeBySession[runtimeSessionId ?? taskId] ?? createEmptyChatRuntime()
    : createEmptyChatRuntime();
  const runtimeIsBusy = isRuntimeRunning(runtime);
  const isGatewayLinked = Boolean(
    taskId &&
      (gwSessionId === taskId ||
        (gwSessionId !== null && gwSessionId !== undefined &&
          (gwSessionId === activeMappedGatewaySessionId ||
            resolvePersistentSessionId(gwSessionId) === restSessionId))),
  );

  // Stay in live mode whenever runtime messages have unsynced content, regardless
  // of streamStatus. Live messages carry richer metadata (TTFT, duration, cost)
  // than REST stored messages, so detail can deduplicate them against stored data.
  const isLiveSession =
    isGatewayLinked ||
    runtimeIsBusy ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.length > 0;

  return {
    restSessionId,
    activeMappedGatewaySessionId,
    runtimeSessionId,
    usageGatewaySessionId: runtimeSessionId ?? activeMappedGatewaySessionId,
    runtime,
    runtimeIsBusy,
    isGatewayLinked,
    isLiveSession,
  };
}

export function useSessionResolution(taskId: string | undefined) {
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  return useMemo(
    () => resolveSessionRuntime(taskId, gwSessionId, runtimeBySession),
    [gwSessionId, runtimeBySession, taskId],
  );
}
