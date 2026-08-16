import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { LoadingState, Popover, StatusDot } from "@hermes/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import type { SessionMessage, SessionSummary } from "@hermes/protocol";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { runtime } from "@/lib/runtime";
import { registerBackConsumer } from "@/lib/android-back-request";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  prefetchSessionMessages,
  sessionListErrorMessage,
  useArchiveSession,
  useDeleteSessions,
  useSessionMessages,
  useSessions,
  useUnarchiveSession,
} from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { useSessionBranch } from "@/hooks/use-session-branch";
import { useIsMobile } from "@/hooks/use-media-query";
import { RecentTable } from "@/components/panel/recent-table";
import { isSessionRunning, mergeLiveRuntimeSessions } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  formatTokens,
  relativeTime,
} from "@/lib/format";
import {
  readPinnedSessionIds,
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
  togglePinnedSession,
  unpinSessions,
} from "@/lib/session-ui-state";
import {
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  subscribeWorkspaceChanges,
  workspaceNameFromPath,
} from "@/lib/workspaces";
import { getSourceMeta, groupSourcesByCategory, type SourceMeta } from "@/lib/source-meta";
import {
  readPinnedSources,
  subscribePinnedSourcesChange,
  togglePinnedSource,
} from "@/lib/source-pin";
import { renameSession } from "@/lib/session-rename";
import { exportSessionJson } from "@/lib/session-export";
import {
  SessionDeleteModal,
  SessionBranchErrorModal,
  SessionExportErrorModal,
  SessionRenameModal,
  SessionRowMenu,
  useSessionRowActions,
} from "@/components/session-actions";
import { TopBar, TopBarActionButton } from "@/components/top-bar/top-bar";
import s from "./history.module.css";

const PAGE_SIZE = 200;
const INLINE_SOURCE_LIMIT = 4;

const MSG_PREVIEW_MAX = 20;
const MSG_PREVIEW_CHAR_LIMIT = 500;

type StatusFilter = "all" | "running" | "done" | "failed";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "全部",
  running: "运行中",
  done: "已完成",
  failed: "失败",
};

type ArchiveScope = "active" | "archived";

function shortId(id: string): string {
  return id.slice(-8);
}

function classifySession(
  session: SessionSummary,
  liveRunning: boolean,
): { kind: "running" | "done" | "failed"; label: string } {
  if (liveRunning) return { kind: "running", label: "运行中" };
  if (session.end_reason === "error" || session.end_reason === "interrupted") {
    return { kind: "failed", label: session.end_reason === "interrupted" ? "已中止" : "失败" };
  }
  return { kind: "done", label: "已完成" };
}

function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

// ── Source filter popover ──

interface SourcePopoverProps {
  selected: string | null;
  pinned: Set<string>;
  counts: Map<string, number>;
  onSelect: (key: string | null) => void;
  onTogglePin: (key: string) => void;
  onClose: () => void;
}

function SourcePopover({
  selected,
  pinned,
  counts,
  onSelect,
  onTogglePin,
  onClose,
}: SourcePopoverProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const sources = Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
    return groupSourcesByCategory(sources);
  }, [counts]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (item) =>
            item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  return (
    <Popover.Portal>
      <Popover.Content
        className={s.popover}
        align="start"
        side="bottom"
        role="dialog"
        aria-label="来源筛选"
      >
        <div className={s.popHead}>
          <Search size={12} />
          <input
            className={s.popSearch}
            placeholder="搜索来源…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className={s.popBody}>
          {filteredGroups.length === 0 ? (
            <div className={s.popEmpty}>未找到来源</div>
          ) : (
            filteredGroups.map((group) => (
              <div key={group.group} className={s.popGroup}>
                <div className={s.popGroupLabel}>{group.label}</div>
                {group.items.map((item) => {
                  const active = selected === item.key;
                  return (
                    <div
                      key={item.key}
                      className={s.popRow}
                      data-checked={active}
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelect(active ? null : item.key);
                        onClose();
                      }}
                    >
                      <span className={s.popCheck}>{active ? "✓" : ""}</span>
                      <span className={s.popName}>{item.label}</span>
                      <button
                        type="button"
                        className={s.popPin}
                        data-pinned={pinned.has(item.key)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onTogglePin(item.key);
                        }}
                        aria-label={pinned.has(item.key) ? "取消置顶" : "置顶"}
                      >
                        {pinned.has(item.key) ? <Pin size={12} /> : <PinOff size={12} />}
                      </button>
                      <span className={s.popCount}>{counts.get(item.key) ?? 0}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </Popover.Content>
    </Popover.Portal>
  );
}

// ── Message preview section ──

function MessagePreview({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error, refetch } = useSessionMessages(sessionId);

  if (isLoading) {
    return (
      <div className={s.messagePreviewLoading}>
        <LoadingState label="" />
        加载对话中…
      </div>
    );
  }

  if (error) {
    return (
      <div className={s.messagePreviewError}>
        <span>加载失败: {String((error as Error).message ?? error)}</span>
        <button type="button" onClick={() => void refetch()}>重试</button>
      </div>
    );
  }

  const messages: SessionMessage[] = data?.messages ?? [];
  if (messages.length === 0) {
    return <div className={s.messagePreviewEmpty}>暂无对话记录</div>;
  }

  const preview = messages.slice(0, MSG_PREVIEW_MAX);

  return (
    <>
      {preview.map((msg, i) => (
        <div key={msg.id ?? i} className={s.msgItem}>
          <span className={s.msgRole}>{msg.role}</span>
          <span className={s.msgContent}>
            {truncateText(stringifyMessageContent(msg.content), MSG_PREVIEW_CHAR_LIMIT)}
          </span>
        </div>
      ))}
      {messages.length > MSG_PREVIEW_MAX && (
        <div className={s.messagePreviewEmpty}>
          还有 {messages.length - MSG_PREVIEW_MAX} 条消息，请打开会话查看全部
        </div>
      )}
    </>
  );
}

// ── Source badge ──

function SourceBadge({ meta }: { meta: SourceMeta }) {
  return (
    <span className={s.sourceChip} data-tone={meta.tone}>
      {meta.label}
    </span>
  );
}

// ── Main component ──

// ── Android Remote-only History ──

function AndroidHistoryRoute() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data, isLoading, error, refetch } = useSessions();
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState(readSessionTitleOverrides);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => readPinnedSessionIds());
  const activeProfile = useActiveProfileName();
  const gateway = useGateway();
  const deleteSessions = useDeleteSessions();
  const archiveSession = useArchiveSession();
  const sessionBranch = useSessionBranch();

  // Explicit action-menu state for the compact history cards.
  const [actionSession, setActionSession] = useState<SessionSummary | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return subscribeSessionUiStateChanges(() => {
      setSessionTitleOverrides(readSessionTitleOverrides());
      setPinnedIds(readPinnedSessionIds());
    });
  }, []);

  const sessions = useMemo(
    () =>
      mergeLiveRuntimeSessions(
        (data?.sessions ?? []).flatMap((session) => {
          const title = sessionTitleOverrides[session.id];
          return title ? [{ ...session, title }] : [session];
        }),
        runtimeBySession,
      ),
    [data?.sessions, runtimeBySession, sessionTitleOverrides],
  );

  const goSession = (sess: SessionSummary) => {
    setActiveId(sess.id);
    navigate(`/tasks/${sess.id}`);
  };

  // ── Session row actions (reuse hook) ──

  const actions = useSessionRowActions({
    deleteSessions: useCallback(
      async (ids: string[]) => {
        await deleteSessions.mutateAsync(ids);
        return { succeededIds: ids };
      },
      [deleteSessions],
    ),
    isDeleting: deleteSessions.isPending,
    setSessionTitle: gateway.setSessionTitle,
    resumeSession: gateway.resumeSession,
    archive: useCallback(
      (id: string) => archiveSession.mutate(id),
      [archiveSession],
    ),
    profile: activeProfile,
    onDeleted: useCallback(() => {
      setActionSession(null);
    }, []),
  });

  // ── Explicit action-menu handler ──

  const handleOpenActions = useCallback(
    (session: SessionSummary, anchorX: number, anchorY: number) => {
      setActionSession(session);
      setMenuAnchor({ x: anchorX, y: anchorY });
    },
    [],
  );

  const menuDisabled =
    !!actionSession &&
    (actions.isDeleting ||
      sessionBranch.branchingSessionId === actionSession.id);

  return (
    <main className={s.androidPage}>
      <TopBar title="历史会话" sub={isLoading ? undefined : `${sessions.length} 个会话`} />

      <div className={s.androidContent}>
        {isLoading ? (
          <div className={s.androidLoading}>
            <LoadingState label="加载会话列表…" />
          </div>
        ) : error ? (
          <div className={s.androidError}>
            <p className={s.androidErrorText}>{sessionListErrorMessage(error)}</p>
            <div className={s.androidActions}>
              <button type="button" className={s.androidBtn} onClick={() => void refetch()}>重试</button>
              <button type="button" className={s.androidBtn} onClick={() => navigate("/connection")}>打开连接设置</button>
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <div className={s.androidEmpty}>
            <span className={s.androidEmptyTitle}>暂无会话</span>
            <span className={s.androidEmptyHint}>连接远程 Dashboard 后，会话将显示在此处</span>
          </div>
        ) : (
          <>
            <div className={s.androidSectionHint}>最近会话 · 点击右侧三个点打开操作菜单</div>
            <RecentTable compact sessions={sessions} onOpen={goSession} onActionMenu={handleOpenActions} />
          </>
        )}
      </div>

      {/* ── Compact card action menu ── */}
      {actionSession && menuAnchor && (
        <Popover.Root
          open
          onOpenChange={(open) => {
            if (!open) {
              setActionSession(null);
              setMenuAnchor(null);
            }
          }}
        >
          <Popover.Trigger asChild>
            <span
              aria-hidden
              style={{
                position: "fixed",
                left: menuAnchor.x,
                top: menuAnchor.y,
                width: 1,
                height: 1,
              }}
            />
          </Popover.Trigger>
          <SessionRowMenu
            pinned={pinnedIds.has(actionSession.id)}
            disabled={menuDisabled}
            archived={false}
            onTogglePin={() => actions.togglePin(actionSession.id)}
            onRename={() => actions.startRename(actionSession)}
            onBranch={() => void sessionBranch.branchSession(actionSession)}
            onExport={() => void actions.handleExport(actionSession)}
            onArchive={() => actions.handleArchive(actionSession)}
            onDelete={() => actions.openDeleteDialog([actionSession])}
          />
        </Popover.Root>
      )}

      {/* ── Action modals ── */}
      {actions.renamingSession && (
        <SessionRenameModal
          value={actions.renameValue}
          saving={actions.renameSaving}
          error={actions.renameError}
          onChange={actions.setRenameValue}
          onClose={actions.closeRename}
          onSubmit={actions.submitRename}
        />
      )}

      {actions.deleteTargets && (
        <SessionDeleteModal
          sessions={actions.deleteTargets}
          deleting={actions.isDeleting}
          onClose={actions.closeDeleteDialog}
          onConfirm={actions.confirmDelete}
        />
      )}

      {sessionBranch.error && (
        <SessionBranchErrorModal
          error={sessionBranch.error}
          onClose={sessionBranch.clearError}
        />
      )}
    </main>
  );
}

function DesktopHistoryRoute() {
  const queryClient = useQueryClient();
  const activeProfile = useActiveProfileName();
  const navigate = useNavigate();
  const gateway = useGateway();
  const liveRunning = useAtomValue(chatRuntimeBySessionAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const isMobile = useIsMobile();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>("active");
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<SessionSummary[] | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => readPinnedSessionIds());
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>(readSessionTitleOverrides);
  const [workspaceMap, setWorkspaceMap] = useState<Record<string, string>>(readSessionWorkspaceMap);
  const [pinnedSources, setPinnedSources] = useState<Set<string>>(readPinnedSources);
  const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");

  useEffect(() => {
    const unsub = subscribeSessionUiStateChanges(() => {
      setPinnedIds(readPinnedSessionIds());
      setTitleOverrides(readSessionTitleOverrides);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = subscribeWorkspaceChanges(() => {
      setWorkspaceMap(readSessionWorkspaceMap());
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = subscribePinnedSourcesChange(() => {
      setPinnedSources(readPinnedSources);
    });
    return unsub;
  }, []);

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useSessions(PAGE_SIZE, 0, {
    includeArchived: archiveScope === "archived",
  });

  const sessions = useMemo<SessionSummary[]>(
    () => (data?.sessions ?? []).map((session) => {
      const overriddenTitle = titleOverrides[session.id];
      return overriddenTitle ? { ...session, title: overriddenTitle } : session;
    }),
    [data?.sessions, titleOverrides],
  );

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const key = session.source || "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);

  const deleteSessions = useDeleteSessions();
  const archiveSession = useArchiveSession();
  const unarchiveSession = useUnarchiveSession();
  const sessionBranch = useSessionBranch();

  // ── Derived data ──

  const filtered = useMemo(() => {
    let result = sessions;

    if (statusFilter !== "all") {
      result = result.filter((session) => {
        const status = classifySession(session, isSessionRunning(session, liveRunning));
        if (statusFilter === "running") return status.kind === "running";
        if (statusFilter === "done") return status.kind === "done";
        if (statusFilter === "failed") return status.kind === "failed";
        return true;
      });
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter((session) => {
        const haystack = [
          sessionDisplayTitle(session),
          session.preview ?? "",
          session.model,
          session.source ?? "",
          session.id,
        ].join(" ").toLowerCase();
        return haystack.includes(query);
      });
    }

    if (selectedSource) {
      result = result.filter((session) => (session.source || "unknown") === selectedSource);
    }

    return result;
  }, [sessions, statusFilter, searchQuery, selectedSource, liveRunning]);

  const totalTokens = useMemo(
    () => filtered.reduce((sum, s) => sum + (s.input_tokens ?? 0) + (s.output_tokens ?? 0), 0),
    [filtered],
  );

  const visibleSessionIds = useMemo(() => filtered.map((s) => s.id), [filtered]);
  const allVisibleSelected = visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedSessionIds.has(id));

  const selectedSession = useMemo(
    () => filtered.find((s) => s.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  // ── Session card handlers ──

  const handleCardClick = useCallback(
    (session: SessionSummary) => {
      if (bulkDeleteMode) {
        toggleSelectedSession(session.id, !selectedSessionIds.has(session.id));
        return;
      }
      setSelectedId(session.id);
      if (isMobile) {
        setViewMode("detail");
      }
      void prefetchSessionMessages(queryClient, activeProfile, session.id);
    },
    [bulkDeleteMode, selectedSessionIds, isMobile, queryClient, activeProfile],
  );

  const handleMobileBack = useCallback(() => {
    setViewMode("list");
  }, []);

  const handleOpenSession = useCallback(
    (session: SessionSummary) => {
      setActiveSessionId(session.id);
      navigate(`/tasks/${session.id}`);
    },
    [navigate, setActiveSessionId],
  );

  // ── Bulk delete ──

  const startBulkDeleteMode = useCallback(() => {
    setBulkDeleteMode(true);
    setSelectedSessionIds(new Set());
  }, []);

  const stopBulkDeleteMode = useCallback(() => {
    setBulkDeleteMode(false);
    setSelectedSessionIds(new Set());
  }, []);

  const toggleSelectedSession = useCallback((id: string, checked: boolean) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectVisibleSessions = useCallback(() => {
    setSelectedSessionIds(new Set(visibleSessionIds));
  }, [visibleSessionIds]);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);

  // ── Delete ──

  const openDeleteDialog = useCallback((targets: SessionSummary[]) => {
    setDeleteTargets(targets);
    setOpenMenuId(null);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteTargets(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTargets || deleteTargets.length === 0) return;
    const ids = deleteTargets.map((s) => s.id);
    await deleteSessions.mutateAsync(ids);
    const deletedSet = new Set(ids);
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      for (const id of deletedSet) next.delete(id);
      return next;
    });
    if (selectedId && deletedSet.has(selectedId)) {
      setSelectedId(null);
      if (isMobile) setViewMode("list");
    }
    setDeleteTargets(null);
    setBulkDeleteMode(false);
    unpinSessions(ids);
  }, [deleteTargets, deleteSessions, selectedId, isMobile]);

  // ── Pin ──

  const onTogglePinSession = useCallback((id: string) => {
    togglePinnedSession(id);
    setOpenMenuId(null);
  }, []);

  // ── Archive ──

  const handleArchive = useCallback((session: SessionSummary) => {
    archiveSession.mutate(session.id);
    setOpenMenuId(null);
  }, [archiveSession]);

  const handleUnarchive = useCallback((session: SessionSummary) => {
    unarchiveSession.mutate(session.id);
    setOpenMenuId(null);
  }, [unarchiveSession]);

  // ── Rename ──

  const startRename = useCallback((session: SessionSummary) => {
    setRenamingSession(session);
    setRenameValue(sessionDisplayTitle(session));
    setRenameError("");
    setOpenMenuId(null);
  }, []);

  const closeRename = useCallback(() => {
    setRenamingSession(null);
    setRenameValue("");
    setRenameError("");
  }, []);

  const submitRename = useCallback(async () => {
    if (!renamingSession) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("名称不能为空");
      return;
    }
    setRenameSaving(true);
    try {
      await renameSession(renamingSession.id, trimmed, {
        setSessionTitle: gateway.setSessionTitle,
        resumeSession: gateway.resumeSession,
      });
      closeRename();
    } catch (err) {
      setRenameError(String((err as Error).message ?? err));
    } finally {
      setRenameSaving(false);
    }
  }, [renamingSession, renameValue, closeRename, gateway]);

  // ── Export ──

  const handleExport = useCallback(async (session: SessionSummary) => {
    try {
      await exportSessionJson(session.id, activeProfile);
    } catch (err) {
      setExportError(String((err as Error).message ?? err));
    }
    setOpenMenuId(null);
  }, [activeProfile]);

  // ── Hover prefetch ──

  const hoverSession = useCallback(
    (session: SessionSummary) => {
      void prefetchSessionMessages(queryClient, activeProfile, session.id);
    },
    [queryClient, activeProfile],
  );

  // ── Status counts ──

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: sessions.length, running: 0, done: 0, failed: 0 };
    for (const session of sessions) {
      const status = classifySession(session, isSessionRunning(session, liveRunning));
      if (status.kind === "running") counts.running++;
      else if (status.kind === "failed") counts.failed++;
      else counts.done++;
    }
    return counts;
  }, [sessions, liveRunning]);

  // ── Sync selectedId when filtered list changes ──

  useEffect(() => {
    if (selectedId && !filtered.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      if (isMobile && viewMode === "detail") setViewMode("list");
    }
  }, [filtered, selectedId, isMobile, viewMode]);

  // Android system back returns from the mobile detail view to the list
  // before walking SPA history.
  useEffect(() => {
    if (!isMobile || viewMode !== "detail") return;
    return registerBackConsumer(() => {
      setViewMode("list");
      return true;
    });
  }, [isMobile, viewMode]);

  // ── Render ──

  const listPanelVisible = !isMobile || viewMode === "list";
  const detailPanelVisible = !isMobile || viewMode === "detail";

  return (
    <main className={s.page} data-testid="history-page">
      {/* ── Top bar ── */}
      <TopBar
        title="历史会话"
        sub={`${sessions.length} 个会话`}
        right={
          <>
            <Popover.Root>
              <Popover.Trigger asChild>
                <TopBarActionButton aria-label="切换归档范围">
                  {archiveScope === "archived" ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  <span>{archiveScope === "archived" ? "归档" : "活跃"}</span>
                </TopBarActionButton>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className={s.popover} align="start" side="bottom">
                  <div className={s.popRow}
                    data-checked={archiveScope === "active"}
                    onClick={() => setArchiveScope("active")}
                  >
                    <span className={s.popCheck}>{archiveScope === "active" ? "✓" : ""}</span>
                    <span className={s.popName}>活跃会话</span>
                  </div>
                  <div className={s.popRow}
                    data-checked={archiveScope === "archived"}
                    onClick={() => setArchiveScope("archived")}
                  >
                    <span className={s.popCheck}>{archiveScope === "archived" ? "✓" : ""}</span>
                    <span className={s.popName}>已归档</span>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <TopBarActionButton
              onClick={bulkDeleteMode ? stopBulkDeleteMode : startBulkDeleteMode}
              aria-label={bulkDeleteMode ? "取消批量删除" : "批量删除"}
            >
              <Trash2 size={16} />
              <span>{bulkDeleteMode ? "取消批量" : "批量删除"}</span>
            </TopBarActionButton>
          </>
        }
      />

      {/* ── Two-panel layout ── */}
      <div className={s.layout} data-mobile={isMobile}>

        {/* ── List Panel ── */}
        {listPanelVisible && (
          <div className={s.listPanel}>
            {/* Filters */}
            <div className={s.filters}>
              <div className={s.filtersRow}>
                <div className={s.seg} role="radiogroup" aria-label="状态筛选">
                  {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={s.segItem}
                      data-active={statusFilter === key}
                      role="radio"
                      aria-checked={statusFilter === key}
                      onClick={() => setStatusFilter(key)}
                    >
                      {STATUS_LABELS[key]}
                      {statusCounts[key] > 0 && (
                        <span className={s.segCount}>{statusCounts[key]}</span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Source filter popover */}
                <Popover.Root open={sourcePopoverOpen} onOpenChange={setSourcePopoverOpen}>
                  <Popover.Trigger asChild>
                    <button type="button" className={s.segItem}>
                      {selectedSource ? (
                        <>
                          <span className={s.segBadge}>
                            {getSourceMeta(selectedSource).label}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedSource(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                                setSelectedSource(null);
                              }
                            }}
                            aria-label="清除来源筛选"
                          >
                            ×
                          </span>
                        </>
                      ) : (
                        <>
                          来源
                          <ChevronDown size={12} className={s.chevOpen} />
                        </>
                      )}
                    </button>
                  </Popover.Trigger>
                  <SourcePopover
                    selected={selectedSource}
                    pinned={pinnedSources}
                    counts={sourceCounts}
                    onSelect={setSelectedSource}
                    onTogglePin={togglePinnedSource}
                    onClose={() => setSourcePopoverOpen(false)}
                  />
                </Popover.Root>

                <label className={s.searchBox}>
                  <Search size={16} />
                  <input
                    placeholder="搜索会话…"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </label>
              </div>
            </div>

            {/* Bulk bar */}
            <div className={s.bulkBar} data-active={bulkDeleteMode}>
              {bulkDeleteMode ? (
                <>
                  <button type="button" onClick={selectVisibleSessions} disabled={visibleSessionIds.length === 0 || allVisibleSelected || deleteSessions.isPending}>
                    全选
                  </button>
                  <button type="button" onClick={clearSelectedSessions} disabled={selectedSessionIds.size === 0 || deleteSessions.isPending}>
                    取消
                  </button>
                  <span className={s.bulkFeedback}>{selectedSessionIds.size} 项已选</span>
                  <button
                    type="button"
                    className={s.bulkDanger}
                    disabled={selectedSessionIds.size === 0 || deleteSessions.isPending}
                    onClick={() => openDeleteDialog(sessions.filter((session) => selectedSessionIds.has(session.id)))}
                  >
                    <Trash2 size={12} />
                    删除
                  </button>
                  <button type="button" onClick={stopBulkDeleteMode} disabled={deleteSessions.isPending}>
                    完成
                  </button>
                </>
              ) : (
                <span>{filtered.length} 个会话</span>
              )}
            </div>

            {/* Card list */}
            <div className={s.cardList}>
              {isLoading ? (
                <LoadingState label="加载会话列表…" />
              ) : error ? (
                <div style={{ padding: "24px 16px" }}>
                  <p style={{ color: "var(--h-err)", marginBottom: 12 }}>
                    {sessionListErrorMessage(error)}
                  </p>
                  <button type="button" onClick={() => void refetch()}>重试</button>
                  <button type="button" onClick={() => navigate("/connection")}>打开连接设置</button>
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: "24px 16px", color: "var(--h-text-3)", textAlign: "center" }}>
                  {searchQuery || selectedSource
                    ? "没有匹配的会话"
                    : archiveScope === "archived"
                      ? "暂无已归档会话"
                      : "暂无会话"}
                </div>
              ) : (
                filtered.map((session) => {
                  const status = classifySession(session, isSessionRunning(session, liveRunning));
                  const pinned = pinnedIds.has(session.id);
                  const meta = getSourceMeta(session.source);
                  const updated = lastActivitySec(session);
                  const selected = selectedId === session.id;

                  return (
                    <div
                      key={session.id}
                      className={s.sessionCard}
                      data-selected={selected}
                      data-status={status.kind}
                      onMouseEnter={() => hoverSession(session)}
                      onClick={() => handleCardClick(session)}
                    >
                      {bulkDeleteMode && (
                        <span className={s.cardBulkCheck}>
                          <input
                            type="checkbox"
                            checked={selectedSessionIds.has(session.id)}
                            disabled={deleteSessions.isPending}
                            aria-label={`选择会话 ${sessionDisplayTitle(session)}`}
                            onChange={(event) => toggleSelectedSession(session.id, event.currentTarget.checked)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </span>
                      )}
                      <span className={s.cardStatusDot}>
                        {status.kind === "running" ? (
                          <StatusDot tone="success" aria-hidden />
                        ) : status.kind === "failed" ? (
                          <StatusDot tone="danger" aria-hidden />
                        ) : (
                          <StatusDot tone="neutral" aria-hidden />
                        )}
                      </span>
                      <div className={s.cardBody}>
                        <div className={s.cardTitleRow}>
                          {pinned && <Pin size={12} className={s.cardTitlePin} aria-hidden />}
                          <span className={s.cardTitle}>{sessionDisplayTitle(session)}</span>
                        </div>
                        <div className={s.cardMeta}>
                          <SourceBadge meta={meta} />
                          <span className={s.cardMetaModel}>{session.model || "—"}</span>
                          <span className={s.cardMetaTime}>{relativeTime(updated)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className={s.foot}>
              <span>
                共 {filtered.length} 个会话 · {formatTokens(totalTokens)} tokens
              </span>
              {data && data.has_more && (
                <span className={s.footNote}>展示前 {sessions.length} 条</span>
              )}
            </div>
          </div>
        )}

        {/* ── Detail Panel ── */}
        {detailPanelVisible && (
          <div className={s.detailPanel}>
            {isMobile && (
              <button type="button" className={s.mobileBack} onClick={handleMobileBack}>
                ← 返回列表
              </button>
            )}

            {!selectedSession ? (
              <div className={s.detailPanelEmpty}>
                <ExternalLink size={48} className={s.detailPanelEmptyIcon} />
                <span className={s.detailPanelEmptyText}>选择一个会话查看详情</span>
              </div>
            ) : (
              (() => {
                const session = selectedSession;
                const status = classifySession(session, isSessionRunning(session, liveRunning));
                const pinned = pinnedIds.has(session.id);
                const meta = getSourceMeta(session.source);
                const workspacePath = normalizeWorkspacePath(workspaceMap[session.id] ?? session.cwd);
                const workspaceName = workspacePath ? workspaceNameFromPath(workspacePath) : "";
                const startedAt = session.started_at ? relativeTime(session.started_at) : "—";
                const endedAt = session.ended_at ? relativeTime(session.ended_at) : "—";
                const cost = session.actual_cost_usd ?? session.estimated_cost_usd;
                const menuDisabled = status.kind === "running" || sessionBranch.branchingSessionId === session.id;

                return (
                  <>
                    {/* Detail header */}
                    <div className={s.detailHeader}>
                      <div className={s.detailTitleRow}>
                        <span className={s.detailTitle}>{sessionDisplayTitle(session)}</span>
                        <div className={s.detailBadges}>
                          <span className={s.detailStatusBadge} data-kind={status.kind}>
                            {status.label}
                          </span>
                        </div>
                      </div>
                      <div className={s.detailIdRow}>
                        <span>#{shortId(session.id)}</span>
                        <CopyButton text={session.id} size="sm">复制 ID</CopyButton>
                      </div>
                      <div className={s.detailActions}>
                        <button
                          type="button"
                          className={s.detailOpenBtn}
                          onClick={() => handleOpenSession(session)}
                        >
                          <ExternalLink size={16} />
                          打开会话
                        </button>
                        <Popover.Root
                          open={!menuDisabled && openMenuId === session.id}
                          onOpenChange={(open) => {
                            setOpenMenuId(open && !menuDisabled ? session.id : null);
                          }}
                        >
                          <Popover.Trigger asChild>
                            <button
                              type="button"
                              className={s.detailMoreBtn}
                              aria-label="会话操作"
                              disabled={menuDisabled}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                          </Popover.Trigger>
                          <SessionRowMenu
                            pinned={pinned}
                            disabled={menuDisabled || sessionBranch.branchingSessionId === session.id}
                            archived={archiveScope === "archived"}
                            onTogglePin={() => onTogglePinSession(session.id)}
                            onRename={() => startRename(session)}
                            onBranch={() => void sessionBranch.branchSession(session)}
                            onExport={() => void handleExport(session)}
                            onArchive={() => handleArchive(session)}
                            onUnarchive={() => handleUnarchive(session)}
                            onDelete={() => openDeleteDialog([session])}
                          />
                        </Popover.Root>
                      </div>
                    </div>

                    {/* Metadata grid */}
                    <div className={s.metaGrid}>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>模型</span>
                        <span className={s.metaValue}>{session.model || "—"}</span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>工作区</span>
                        <span className={s.metaValue}>{workspaceName || "—"}</span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>来源</span>
                        <span className={s.metaValue}>{meta.label}</span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>开始时间</span>
                        <span className={s.metaValue}>{startedAt}</span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>结束时间</span>
                        <span className={s.metaValue}>{endedAt}</span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>Token</span>
                        <span className={s.metaValue}>
                          {formatTokens(session.input_tokens)} in / {formatTokens(session.output_tokens)} out
                        </span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>费用</span>
                        <span className={s.metaValue}>
                          {cost != null ? `$${cost.toFixed(4)}` : "—"}
                        </span>
                      </div>
                      <div className={s.metaItem}>
                        <span className={s.metaLabel}>消息数</span>
                        <span className={s.metaValue}>{session.message_count}</span>
                      </div>
                    </div>

                    {/* Message preview */}
                    <div className={s.messagePreview}>
                      <div className={s.messagePreviewTitle}>对话预览</div>
                      <MessagePreview sessionId={session.id} />
                    </div>
                  </>
                );
              })()
            )}
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {renamingSession ? (
        <SessionRenameModal
          value={renameValue}
          saving={renameSaving}
          error={renameError}
          onChange={(next) => {
            setRenameValue(next);
            if (renameError) setRenameError("");
          }}
          onClose={closeRename}
          onSubmit={submitRename}
        />
      ) : null}

      {deleteTargets ? (
        <SessionDeleteModal
          sessions={deleteTargets}
          deleting={deleteSessions.isPending}
          onClose={closeDeleteDialog}
          onConfirm={confirmDelete}
        />
      ) : null}

      {exportError ? (
        <SessionExportErrorModal error={exportError} onClose={() => setExportError("")} />
      ) : null}

      {sessionBranch.error ? (
        <SessionBranchErrorModal
          error={sessionBranch.error}
          onClose={sessionBranch.clearError}
        />
      ) : null}
    </main>
  );
}

export function HistoryRoute() {
  if (runtime.androidRemoteOnly) return <AndroidHistoryRoute />;
  return <DesktopHistoryRoute />;
}
