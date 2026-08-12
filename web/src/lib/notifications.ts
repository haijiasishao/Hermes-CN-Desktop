// 桌面通知触发链路（issue #194）。
//
// 在 applyGatewayEventAtom 消费 Gateway 事件时旁路调用（见 stores/chat.ts），
// 把「任务完成 / 需要权限确认」翻译成 desktop_notify IPC：Rust 侧负责前台
// 判定、系统通知（自带原生提示音）和 dock 弹跳 / 任务栏闪烁；本模块负责
// 决策（设置开关、防重放去重、文案）和系统通知不可用时的 WebAudio 兜底音。
//
// decideNotification / shouldPlayFallbackSound 是纯函数，便于 vitest 全矩阵
// 覆盖；所有副作用都 fire-and-forget 且错误吞掉，绝不影响聊天主流程。

import type {
  GatewayEvent,
  HermesUIMessage,
  MessagesResponse,
  SessionsResponse,
} from "@hermes/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import { messagesResponseToHermesUIMessages } from "@/components/chat/message-adapter";
import { readNotificationSettings, type NotificationSettings } from "@/stores/ui";
import { resolvePersistentSessionId } from "@/lib/session-map";
import { queryClient } from "@/lib/query-client";
import { runtime, type DesktopNotifyResult } from "@/lib/runtime";
import { recordNotificationDebug } from "@/lib/notification-debug";

export interface NotificationAction {
  dedupeKey: string;
  kind: "approval" | "complete" | "error";
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 120;
const SUMMARY_CHARS = 80;
const SESSION_TITLE_CHARS = 24;
const MAX_DEDUPE_KEYS = 500;

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  // 按码点切，`slice` 按 UTF-16 截断会把 emoji 的代理对劈成孤立代理字符。
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function payloadOf(event: GatewayEvent): Record<string, any> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, any>)
    : {};
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function lastUserPromptSummary(
  runtime: ChatSessionRuntime | undefined,
  max: number,
): string | undefined {
  if (!runtime) return undefined;
  for (let i = runtime.messages.length - 1; i >= 0; i -= 1) {
    const message = runtime.messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) return truncate(text, max);
  }
  return undefined;
}

export function decideNotification(input: {
  event: GatewayEvent;
  prevRuntime: ChatSessionRuntime | undefined;
  settings: NotificationSettings;
  alreadyNotified: (key: string) => boolean;
}): NotificationAction | null {
  const { event, prevRuntime, settings, alreadyNotified } = input;
  // 总闸：系统通知和提示音都关 = 用户不要任何打扰（注意力请求也不发）。
  if (!settings.system && !settings.sound) return null;
  const sessionId = event.session_id;
  if (!sessionId) return null;
  const payload = payloadOf(event);

  if (event.type === "approval.request") {
    if (!settings.onApproval) return null;
    const rawId = payload.request_id;
    const requestId =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    // 没有可靠 request_id 就无法去重，宁可不通知也不在重放时轰炸。
    if (!requestId) return null;
    if (prevRuntime?.pendingApprovals.some((item) => item.requestId === requestId)) {
      return null;
    }
    const persistentSessionId = resolvePersistentSessionId(sessionId) ?? sessionId;
    const dedupeKey = `approval:${persistentSessionId}:${requestId}`;
    if (alreadyNotified(dedupeKey)) return null;
    const detail = firstNonEmptyString([payload.command, payload.reason, payload.description]);
    return {
      dedupeKey,
      kind: "approval",
      title: "需要权限确认",
      body: truncate(detail ?? "任务等待你的确认后才能继续", MAX_BODY_CHARS),
    };
  }

  if (event.type === "message.complete") {
    if (!settings.onComplete) return null;
    // 重放防护：本地没有活跃回合（SSE 重连重放、历史 resume）或用户已手动
    // 中断时不通知。reducer 收尾后会清空 activeAssistantId，因此同一回合
    // 只有一次「在场」的 complete。
    const activeId = prevRuntime?.activeAssistantId;
    if (!activeId || prevRuntime?.interrupted) return null;
    const persistentSessionId = resolvePersistentSessionId(sessionId) ?? sessionId;
    const dedupeKey = `complete:${persistentSessionId}:${activeId}`;
    if (alreadyNotified(dedupeKey)) return null;
    if (payload.status === "error") {
      const detail = firstNonEmptyString([
        payload.error,
        payload.message,
        payload.warning,
        payload.detail,
      ]);
      return {
        dedupeKey,
        kind: "error",
        title: "任务出错",
        body: truncate(detail ?? "任务执行失败，请回来查看详情", MAX_BODY_CHARS),
      };
    }
    return {
      dedupeKey,
      kind: "complete",
      title: "任务完成",
      body: lastUserPromptSummary(prevRuntime, SUMMARY_CHARS) ?? "会话回复已就绪",
    };
  }

  return null;
}

// ── 去重存储（module 级，FIFO 上限防泄漏）─────────────────────────────

const notifiedKeys = new Set<string>();
const notifiedOrder: string[] = [];

export function hasNotified(key: string): boolean {
  return notifiedKeys.has(key);
}

export function markNotified(key: string): void {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  notifiedOrder.push(key);
  while (notifiedOrder.length > MAX_DEDUPE_KEYS) {
    const oldest = notifiedOrder.shift();
    if (oldest !== undefined) notifiedKeys.delete(oldest);
  }
}

function unmarkNotified(key: string): void {
  if (!notifiedKeys.delete(key)) return;
  const index = notifiedOrder.indexOf(key);
  if (index >= 0) notifiedOrder.splice(index, 1);
}

export function __resetNotificationsForTests(): void {
  notifiedKeys.clear();
  notifiedOrder.length = 0;
}

// ── 会话标题（通知正文前缀）────────────────────────────────────────────

function sessionTitleFor(sessionId: string): string | undefined {
  try {
    const persistentId = resolvePersistentSessionId(sessionId) ?? sessionId;
    for (const [, data] of queryClient.getQueriesData<SessionsResponse>({
      queryKey: ["sessions"],
    })) {
      const match = data?.sessions.find((item) => item.id === persistentId);
      if (match?.title) return match.title;
    }
  } catch {
    // 标题只是锦上添花，任何失败都退回裸正文。
  }
  return undefined;
}

function bodyWithSessionTitle(body: string, sessionId: string): string {
  const title = sessionTitleFor(sessionId);
  if (!title) return body;
  return `「${truncate(title, SESSION_TITLE_CHARS)}」${body ? ` · ${body}` : ""}`;
}

// ── 提示音兜底 ──────────────────────────────────────────────────────────

export function shouldPlayFallbackSound(
  settings: NotificationSettings,
  result: Pick<DesktopNotifyResult, "delivered" | "focused" | "error">,
): boolean {
  if (!settings.sound) return false;
  // 窗口在前台且用户只要后台提醒：Rust 侧已整体抑制，这里也保持安静。
  if (result.focused && settings.onlyBackground) return false;
  // 系统通知正常发出时提示音由通知自身携带，不再补播。
  if (settings.system && result.delivered && !result.error) return false;
  return true;
}

let chimeAudioContext: AudioContext | undefined;

function chimeContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  try {
    if (!chimeAudioContext) chimeAudioContext = new AudioContext();
    if (chimeAudioContext.state === "suspended") {
      void chimeAudioContext.resume().catch(() => {});
    }
    return chimeAudioContext;
  } catch {
    return undefined;
  }
}

/** WebAudio 合成的两音上行 chime（A5 → E6，约 0.45s），零音频资产。 */
export function playChime(): void {
  const ctx = chimeContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    gain.connect(ctx.destination);
    const notes: ReadonlyArray<readonly [number, number]> = [
      [880, now],
      [1318.5, now + 0.12],
    ];
    for (const [frequency, at] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(now + 0.5);
    }
  } catch {
    // 播放失败保持静默。
  }
}

function notificationDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!runtime.androidRemoteOnly || typeof console === "undefined") return;
  recordNotificationDebug("diagnostic", { message, ...(details ?? {}) }, "warn");
  try {
    console.warn("[Hermes notification]", message, details ?? {});
  } catch {
    // Diagnostics must never affect notification delivery.
  }
}

function documentNotificationState(): {
  documentVisibilityState: string;
  documentHasFocus: boolean | null;
} {
  if (typeof document === "undefined") {
    return { documentVisibilityState: "unavailable", documentHasFocus: null };
  }
  return {
    documentVisibilityState:
      typeof document.visibilityState === "string" ? document.visibilityState : "unknown",
    documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
  };
}

function commitOrReleaseNotification(
  dedupeKey: string,
  settings: NotificationSettings,
  result: DesktopNotifyResult | undefined,
  source: "gateway-event" | "reconnect-snapshot",
  respectFocus: boolean,
): void {
  recordNotificationDebug(
    "native.result",
    {
      source,
      respectFocus,
      ...documentNotificationState(),
      delivered: Boolean(result?.delivered),
      focused: Boolean(result?.focused),
      visible: Boolean(result?.visible),
      rawFocused: result?.rawFocused ?? null,
      rawVisible: result?.rawVisible ?? null,
      effectiveForeground: result?.effectiveForeground ?? null,
      attentionRequested: Boolean(result?.attentionRequested),
      error: result?.error ?? null,
    },
    result && !result.delivered && !(result.focused && settings.onlyBackground) ? "warn" : "info",
  );
  // A focused window with only-background enabled is an intentional suppression,
  // not a transport failure. All other `delivered:false` results remain retryable
  // so a reconnect snapshot can recover after a transient Android IPC failure.
  const intentionallySuppressed = Boolean(result?.focused && settings.onlyBackground);
  if (!result || result.delivered || intentionallySuppressed) {
    markNotified(dedupeKey);
  } else {
    unmarkNotified(dedupeKey);
    notificationDiagnostic("native notification was not delivered", {
      source,
      focused: result.focused,
      error: result.error ?? "",
    });
  }
}

function notificationSettingsDebug(settings: NotificationSettings): Record<string, boolean> {
  return {
    system: settings.system,
    sound: settings.sound,
    onComplete: settings.onComplete,
    onApproval: settings.onApproval,
    onlyBackground: settings.onlyBackground,
  };
}

function decisionSkipReason(
  event: GatewayEvent,
  prevRuntime: ChatSessionRuntime | undefined,
  settings: NotificationSettings,
): string {
  if (!settings.system && !settings.sound) return "channels_disabled";
  if (!event.session_id) return "missing_session_id";
  const payload = payloadOf(event);
  if (event.type === "approval.request") {
    if (!settings.onApproval) return "approval_disabled";
    const requestId = payload.request_id;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return "missing_request_id";
    }
    if (prevRuntime?.pendingApprovals.some((item) => item.requestId === String(requestId))) {
      return "approval_already_pending";
    }
    const persistentSessionId = resolvePersistentSessionId(event.session_id) ?? event.session_id;
    if (hasNotified(`approval:${persistentSessionId}:${String(requestId)}`)) {
      return "already_notified";
    }
    return "not_actionable";
  }
  if (event.type === "message.complete") {
    if (!settings.onComplete) return "complete_disabled";
    if (!prevRuntime?.activeAssistantId) return "no_active_assistant";
    if (prevRuntime.interrupted) return "interrupted";
    const persistentSessionId = resolvePersistentSessionId(event.session_id) ?? event.session_id;
    if (hasNotified(`complete:${persistentSessionId}:${prevRuntime.activeAssistantId}`)) {
      return "already_notified";
    }
    return "not_actionable";
  }
  return "unsupported_event";
}

// ── 触发器（副作用入口，错误全吞）──────────────────────────────────────

export function notifyFromGatewayEvent(
  event: GatewayEvent,
  prevRuntime: ChatSessionRuntime | undefined,
): void {
  let dispatchedDedupeKey: string | undefined;
  try {
    const settings = readNotificationSettings();
    const relevantEvent = event.type === "message.complete" || event.type === "approval.request";
    if (relevantEvent) {
      recordNotificationDebug("gateway-event.received", {
        eventType: event.type,
        sessionId: event.session_id ?? null,
        hasActiveAssistant: Boolean(prevRuntime?.activeAssistantId),
        interrupted: Boolean(prevRuntime?.interrupted),
        settings: notificationSettingsDebug(settings),
      });
    }
    const bridge = window.hermesDesktop;
    if (typeof bridge?.desktopNotify !== "function") {
      notificationDiagnostic("desktop notification bridge is unavailable", {
        source: "gateway-event",
        eventType: event.type,
      });
      if (relevantEvent) {
        recordNotificationDebug("gateway-event.skipped", {
          reason: "bridge_unavailable",
          eventType: event.type,
          sessionId: event.session_id ?? null,
        });
      }
      return;
    }
    const action = decideNotification({
      event,
      prevRuntime,
      settings,
      alreadyNotified: hasNotified,
    });
    if (!action || !event.session_id) {
      if (relevantEvent) {
        recordNotificationDebug("gateway-event.skipped", {
          reason: decisionSkipReason(event, prevRuntime, settings),
          eventType: event.type,
          sessionId: event.session_id ?? null,
        });
      }
      return;
    }
    dispatchedDedupeKey = action.dedupeKey;
    markNotified(action.dedupeKey);
    recordNotificationDebug("gateway-event.dispatch", {
      eventType: event.type,
      sessionId: event.session_id,
      kind: action.kind,
      hasActiveAssistant: Boolean(prevRuntime?.activeAssistantId),
      settings: notificationSettingsDebug(settings),
    });
    void bridge
      .desktopNotify({
        kind: action.kind,
        title: action.title,
        body: bodyWithSessionTitle(action.body, event.session_id),
        showSystemNotification: settings.system,
        withSound: settings.sound,
        respectFocus: settings.onlyBackground,
        requestAttention: true,
      })
      .then((result) => {
        commitOrReleaseNotification(
          action.dedupeKey,
          settings,
          result,
          "gateway-event",
          settings.onlyBackground,
        );
        if (result && shouldPlayFallbackSound(settings, result)) playChime();
      })
      .catch((error: unknown) => {
        unmarkNotified(action.dedupeKey);
        notificationDiagnostic("native notification IPC rejected", {
          source: "gateway-event",
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
      });
  } catch (error) {
    if (dispatchedDedupeKey) unmarkNotified(dispatchedDedupeKey);
    notificationDiagnostic("notification dispatch threw", {
      source: "gateway-event",
      error: error instanceof Error ? error.message : String(error ?? ""),
    });
    // 通知永远不能影响聊天主流程。
  }
}

// ── Reconnect-snapshot notification ─────────────────────────────────
//
// When the app is backgrounded (especially on Android) the WebSocket drops
// and the server's message.complete event is lost.  On reconnect,
// session.resume has nothing to re-pin (turn already ended), so the normal
// notifyFromGatewayEvent path never fires.
//
// This helper is called from the reconnect handler after the REST
// session-messages snapshot has been refreshed.  If the snapshot shows a
// completed or errored assistant turn that the local runtime still thinks
// is in-flight, we fire the notification here.  The dedupe key is
// identical to what notifyFromGatewayEvent would produce, so a later real
// message.complete (if one ever arrives) is silently deduplicated.

function hasStoredFinalContent(message: HermesUIMessage): boolean {
  if (message.status === "error") return true;
  return message.parts.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      part.type === "image",
  );
}

export function notifyFromReconnectSnapshot(
  sessionId: string,
  runtime: ChatSessionRuntime,
  messagesResponse: MessagesResponse | null | undefined,
): void {
  let dispatchedDedupeKey: string | undefined;
  try {
    recordNotificationDebug("reconnect-snapshot.started", {
      sessionId,
      activeAssistantId: runtime.activeAssistantId ?? null,
      interrupted: Boolean(runtime.interrupted),
      hasTurnStartedAt: runtime.turnStartedAt !== undefined,
      responsePresent: Boolean(messagesResponse),
    });
    const bridge = window.hermesDesktop;
    if (typeof bridge?.desktopNotify !== "function") {
      notificationDiagnostic("desktop notification bridge is unavailable", {
        source: "reconnect-snapshot",
      });
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "bridge_unavailable",
        sessionId,
      });
      return;
    }
    const activeId = runtime.activeAssistantId;
    if (!activeId) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "no_active_assistant",
        sessionId,
      });
      return;
    }
    if (runtime.interrupted) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "interrupted",
        sessionId,
        activeAssistantId: activeId,
      });
      return;
    }
    if (runtime.turnStartedAt === undefined) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "missing_turn_started_at",
        sessionId,
        activeAssistantId: activeId,
      });
      return;
    }

    const settings = readNotificationSettings();
    if (!settings.onComplete) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "complete_disabled",
        sessionId,
        activeAssistantId: activeId,
        settings: notificationSettingsDebug(settings),
      });
      return;
    }
    if (!settings.system && !settings.sound) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "channels_disabled",
        sessionId,
        activeAssistantId: activeId,
        settings: notificationSettingsDebug(settings),
      });
      return;
    }

    const storedMessages = messagesResponseToHermesUIMessages(messagesResponse ?? undefined);
    const assistantMessages = storedMessages.filter((message) => message.role === "assistant");
    const completedAssistantMessages = assistantMessages.filter(
      (message) => message.status === "complete" || message.status === "error",
    );
    recordNotificationDebug("reconnect-snapshot.loaded", {
      sessionId,
      activeAssistantId: activeId,
      storedMessageCount: storedMessages.length,
      assistantCount: assistantMessages.length,
      completedAssistantCount: completedAssistantMessages.length,
      latestAssistantStatus: assistantMessages.at(-1)?.status ?? null,
      latestAssistantCreatedAt: assistantMessages.at(-1)?.createdAt ?? null,
      turnStartedAt: runtime.turnStartedAt,
    });
    const latestAssistant = [...storedMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          (message.status === "complete" || message.status === "error") &&
          message.createdAt >= runtime.turnStartedAt! &&
          hasStoredFinalContent(message),
      );
    if (!latestAssistant) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "no_matching_final_assistant",
        sessionId,
        activeAssistantId: activeId,
        storedMessageCount: storedMessages.length,
        assistantCount: assistantMessages.length,
        completedAssistantCount: completedAssistantMessages.length,
        turnStartedAt: runtime.turnStartedAt,
      });
      return;
    }

    const persistentSessionId = resolvePersistentSessionId(sessionId) ?? sessionId;
    const dedupeKey = `complete:${persistentSessionId}:${activeId}`;
    if (hasNotified(dedupeKey)) {
      recordNotificationDebug("reconnect-snapshot.skipped", {
        reason: "already_notified",
        sessionId,
        persistentSessionId,
        activeAssistantId: activeId,
        assistantId: latestAssistant.id,
      });
      return;
    }

    recordNotificationDebug("reconnect-snapshot.matched", {
      sessionId,
      persistentSessionId,
      activeAssistantId: activeId,
      assistantId: latestAssistant.id,
      assistantStatus: latestAssistant.status,
      assistantCreatedAt: latestAssistant.createdAt,
    });

    const isError = latestAssistant.status === "error";
    const errorText = latestAssistant.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .find(Boolean);
    const body = isError
      ? truncate(errorText || "任务执行失败，请回来查看详情", MAX_BODY_CHARS)
      : lastUserPromptSummary(runtime, SUMMARY_CHARS) ?? "会话回复已就绪";
    const catchupSettings = { ...settings, onlyBackground: false };

    dispatchedDedupeKey = dedupeKey;
    markNotified(dedupeKey);
    recordNotificationDebug("reconnect-snapshot.dispatch", {
      sessionId,
      persistentSessionId,
      activeAssistantId: activeId,
      assistantId: latestAssistant.id,
      kind: isError ? "error" : "complete",
      settings: notificationSettingsDebug(settings),
      respectFocus: false,
    });
    void bridge
      .desktopNotify({
        kind: isError ? "error" : "complete",
        title: isError ? "任务出错" : "任务完成",
        body: bodyWithSessionTitle(body, sessionId),
        showSystemNotification: settings.system,
        withSound: settings.sound,
        // This is a catch-up notification for work that completed while the
        // app was backgrounded; do not suppress it merely because reattach
        // itself is now running in the foreground.
        respectFocus: false,
        requestAttention: true,
      })
      .then((result) => {
        commitOrReleaseNotification(dedupeKey, settings, result, "reconnect-snapshot", false);
        if (result && shouldPlayFallbackSound(catchupSettings, result)) playChime();
      })
      .catch((error: unknown) => {
        unmarkNotified(dedupeKey);
        notificationDiagnostic("native notification IPC rejected", {
          source: "reconnect-snapshot",
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
      });
  } catch (error) {
    if (dispatchedDedupeKey) unmarkNotified(dispatchedDedupeKey);
    notificationDiagnostic("notification dispatch threw", {
      source: "reconnect-snapshot",
      error: error instanceof Error ? error.message : String(error ?? ""),
    });
    // 通知永远不能影响聊天主流程。
  }
}
