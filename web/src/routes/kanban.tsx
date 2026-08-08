import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X, Layers, Eye } from "lucide-react";
import { useIsMobile } from "@/hooks/use-media-query";
import { SectionShell } from "./section-shell";
import {
  STATUS_ORDER,
  STATUS_LABELS,
  STATUS_COLORS,
  kanbanErrorToChinese,
  formatKanbanDate,
  selectKanbanStatus,
  fetchKanbanBoard,
  fetchKanbanStats,
  fetchKanbanTask,
  type NormalizedBoard,
  type KanbanColumn,
  type KanbanTask,
  type KanbanStats,
  type NormalizedTask,
} from "@/lib/kanban";
import s from "./kanban.module.css";

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL = 15_000;

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  useEffect(() => {
    const handler = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);
  return visible;
}

/* ------------------------------------------------------------------ */
/* Stats Strip                                                         */
/* ------------------------------------------------------------------ */

function StatsBar({ stats }: { stats: KanbanStats | null }) {
  if (!stats) return null;
  const entries = STATUS_ORDER
    .filter((s) => (stats.by_status[s] ?? 0) > 0)
    .map((s) => ({ status: s, count: stats.by_status[s] }));

  if (entries.length === 0 && stats.total === 0) return null;

  return (
    <div className={s.statsStrip} role="list" aria-label="看板统计">
      <div className={s.statChip} role="listitem">
        <span className={s.statDot} style={{ background: "var(--h-accent)" }} />
        <span>全部</span>
        <span className={s.statCount}>{stats.total}</span>
      </div>
      {entries.map((entry) => (
        <div key={entry.status} className={s.statChip} role="listitem">
          <span className={s.statDot} style={{ background: STATUS_COLORS[entry.status] ?? "#888" }} />
          <span>{STATUS_LABELS[entry.status] ?? entry.status}</span>
          <span className={s.statCount}>{entry.count}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task Card                                                           */
/* ------------------------------------------------------------------ */

function TaskCard({ task, onClick }: { task: KanbanTask; onClick: () => void }) {
  return (
    <button type="button" className={s.taskCard} onClick={onClick} aria-label={task.title}>
      <div className={s.taskTitle}>{task.title || "未命名任务"}</div>
      {task.latest_summary || task.result ? (
        <div className={s.taskSummary}>{task.latest_summary || task.result}</div>
      ) : null}
      <div className={s.taskMeta}>
        {task.id ? <span className={s.taskId}>{task.id}</span> : null}
        {task.priority && task.priority !== "normal" ? (
          <span className={s.taskPriority}>{task.priority}</span>
        ) : null}
        {task.assignee ? <span className={s.taskAssignee}>{task.assignee}</span> : null}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

function KanbanColumnView({
  column,
  onSelectTask,
}: {
  column: KanbanColumn;
  onSelectTask: (id: string) => void;
}) {
  const color = STATUS_COLORS[column.name] ?? "#888";
  const label = STATUS_LABELS[column.name] ?? column.name;
  return (
    <section className={s.column} aria-label={`${label} 列`}>
      <div className={s.columnHeader}>
        <span className={s.columnDot} style={{ background: color }} />
        <span className={s.columnName}>{label}</span>
        <span className={s.columnCount}>({column.tasks.length})</span>
      </div>
      {column.tasks.length === 0 ? (
        <div className={s.emptyColumn}>暂无任务</div>
      ) : (
        <div className={s.taskList}>
          {column.tasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => onSelectTask(task.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Board View (desktop ≥ 720px)                                        */
/* ------------------------------------------------------------------ */

function BoardView({
  columns,
  onSelectTask,
}: {
  columns: KanbanColumn[];
  onSelectTask: (id: string) => void;
}) {
  return (
    <div className={s.columnsScroll}>
      <div className={s.columns}>
        {columns.map((col) => (
          <KanbanColumnView key={col.name} column={col} onSelectTask={onSelectTask} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status Selector (mobile < 720px)                                    */
/* ------------------------------------------------------------------ */

function StatusSelector({
  columns,
  selected,
  onSelect,
}: {
  columns: KanbanColumn[];
  selected: string;
  onSelect: (status: string) => void;
}) {
  return (
    <div className={s.statusSelector} role="tablist" aria-label="状态选择">
      {columns.map((col) => {
        const label = STATUS_LABELS[col.name] ?? col.name;
        return (
          <button
            key={col.name}
            type="button"
            className={s.statusTab}
            role="tab"
            data-active={col.name === selected ? "true" : undefined}
            aria-selected={col.name === selected}
            onClick={() => onSelect(col.name)}
          >
            {label}
            <span className={s.tabCount}>{col.tasks.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function MobileColumnView({
  column,
  onSelectTask,
}: {
  column: KanbanColumn;
  onSelectTask: (id: string) => void;
}) {
  if (column.tasks.length === 0) {
    return <div className={s.emptyColumn}>暂无任务</div>;
  }
  return (
    <div className={s.mobileTaskList}>
      {column.tasks.map((task) => (
        <TaskCard key={task.id} task={task} onClick={() => onSelectTask(task.id)} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task Detail Drawer                                                  */
/* ------------------------------------------------------------------ */

function TaskDetail({
  task,
  onClose,
}: {
  task: NormalizedTask | null;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!task) return null;

  const statusLabel = STATUS_LABELS[task.status] ?? task.status;
  const statusColor = STATUS_COLORS[task.status] ?? "#888";

  return (
    <>
      <div className={s.detailOverlay} onClick={onClose} aria-hidden="true" />
      <div className={s.detailDrawer} ref={drawerRef} role="dialog" aria-modal="true" aria-label="任务详情">
        <div className={s.detailHeader}>
          <div className={s.detailTitle}>{task.title}</div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭详情">
            <X size={20} />
          </button>
        </div>
        <div className={s.detailBody}>
          <div className={s.detailFields}>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>状态</span>
              <span className={s.detailFieldValue}>
                <span
                  className={s.detailStatusDot}
                  style={{
                    background: statusColor,
                  }}
                />
                {statusLabel}
              </span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>ID</span>
              <span className={s.detailFieldValue} style={{ fontFamily: "var(--h-font-mono)" }}>
                {task.id || "—"}
              </span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>优先级</span>
              <span className={s.detailFieldValue}>{task.priority || "normal"}</span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>指派人</span>
              <span className={s.detailFieldValue}>{task.assignee || "未指派"}</span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>创建时间</span>
              <span className={s.detailFieldValue}>{formatKanbanDate(task.created_at)}</span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>开始时间</span>
              <span className={s.detailFieldValue}>{formatKanbanDate(task.started_at)}</span>
            </div>
            <div className={s.detailField}>
              <span className={s.detailFieldLabel}>完成时间</span>
              <span className={s.detailFieldValue}>{formatKanbanDate(task.completed_at)}</span>
            </div>
          </div>

          {task.description ? (
            <div className={s.detailSection}>
              <div className={s.detailSectionTitle}>描述</div>
              <div className={s.detailDescription}>{task.description}</div>
            </div>
          ) : null}

          {task.latest_summary || task.result ? (
            <div className={s.detailSection}>
              <div className={s.detailSectionTitle}>最近结果</div>
              <div className={s.detailDescription}>{task.latest_summary || task.result}</div>
            </div>
          ) : null}

          {task.comments.length > 0 ? (
            <div className={s.detailSection}>
              <div className={s.detailSectionTitle}>评论 ({task.comments.length})</div>
              {task.comments.map((c, i) => (
                <div key={i} className={s.commentItem}>
                  <span className={s.commentAuthor}>{c.author || "匿名"}</span>
                  <span className={s.commentText}>{c.text}</span>
                  <span className={s.commentTime}>{formatKanbanDate(c.created_at)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {task.runs.length > 0 ? (
            <div className={s.detailSection}>
              <div className={s.detailSectionTitle}>运行记录 ({task.runs.length})</div>
              {task.runs.map((r, i) => (
                <div key={i} className={s.runItem}>
                  <span className={s.runStatus}>{r.status}</span>
                  <span>{formatKanbanDate(r.started_at)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Main Route                                                          */
/* ------------------------------------------------------------------ */

export function KanbanRoute() {
  const isMobile = useIsMobile();
  const visible = usePageVisible();
  const [board, setBoard] = useState<NormalizedBoard | null>(null);
  const [stats, setStats] = useState<KanbanStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string>("todo");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<NormalizedTask | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback(async (isManual = false) => {
    try {
      if (isManual) setRefreshing(true);
      const [boardResult, statsResult] = await Promise.allSettled([
        fetchKanbanBoard(),
        fetchKanbanStats(),
      ]);

      if (boardResult.status === "fulfilled") {
        setBoard(boardResult.value);
        setError(null);
      } else {
        const err = boardResult.reason;
        const status = typeof err === "object" && err !== null && "status" in err
          ? (err as { status: number }).status
          : err;
        setError(kanbanErrorToChinese(status));
      }

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value);
      }
      // Stats failure is non-blocking
    } catch (err) {
      setError(kanbanErrorToChinese(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial + polling
  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  useEffect(() => {
    if (!visible) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(() => void doFetch(), POLL_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [visible, doFetch]);

  useEffect(() => {
    if (!board) return;
    setSelectedStatus((current) => selectKanbanStatus(board.columns, current));
  }, [board]);

  // Task detail fetch
  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      setTaskError(null);
      return;
    }
    let cancelled = false;
    setTaskLoading(true);
    setTaskError(null);
    fetchKanbanTask(selectedTaskId)
      .then((result) => {
        if (cancelled) return;
        setTaskDetail(result);
        if (!result) setTaskError("无法加载任务详情");
      })
      .catch((err) => {
        if (cancelled) return;
        setTaskError(kanbanErrorToChinese(err));
      })
      .finally(() => {
        if (!cancelled) setTaskLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedTaskId]);

  // On mobile, always use status selector; desktop keeps the multi-column board.
  const showStatusSelector = isMobile;

  const selectedColumn = board?.columns.find((c) => c.name === selectedStatus) ?? null;

  const handleCloseDetail = useCallback(() => {
    setSelectedTaskId(null);
    setTaskDetail(null);
    setTaskError(null);
  }, []);

  const handleRefresh = useCallback(() => {
    void doFetch(true);
  }, [doFetch]);

  const taskCount = board?.columns.reduce((sum, c) => sum + c.tasks.length, 0) ?? 0;

  return (
    <SectionShell
      title="看板"
      sub={board ? `${taskCount} 个任务` : "Kanban"}
      right={
        <div className={s.topActions}>
          <button
            type="button"
            className={s.refreshBtn}
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="刷新看板"
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
      }
    >
      <div className={s.board}>
        {/* Error */}
        {error ? (
          <div className={s.errorBox} role="alert">
            <div>{error}</div>
            <button type="button" onClick={handleRefresh}>
              重试
            </button>
          </div>
        ) : null}

        {/* Loading */}
        {loading && !board ? (
          <div className={s.loading}>正在加载看板数据…</div>
        ) : null}

        {/* Stats */}
        <StatsBar stats={stats} />

        {/* Board */}
        {board && board.columns.length > 0 ? (
          showStatusSelector ? (
            <>
              <StatusSelector
                columns={board.columns}
                selected={selectedStatus}
                onSelect={setSelectedStatus}
              />
              {selectedColumn ? (
                <MobileColumnView
                  column={selectedColumn}
                  onSelectTask={setSelectedTaskId}
                />
              ) : (
                <div className={s.emptyColumn}>请先选择一个状态</div>
              )}
            </>
          ) : (
            <BoardView columns={board.columns} onSelectTask={setSelectedTaskId} />
          )
        ) : null}

        {/* Empty board (no error, not loading) */}
        {board && board.columns.length === 0 && !error && !loading ? (
          <div className={s.emptyColumn}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <Layers size={32} style={{ opacity: 0.4 }} />
              <span>看板数据为空</span>
            </div>
          </div>
        ) : null}

        {/* Stats link */}
        {board && (
          <div style={{ fontSize: 11, color: "var(--h-text-3)", display: "flex", gap: 12 }}>
            <span>
              <Eye size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              只读模式 · 约 15 秒自动刷新
            </span>
            {board.now && (
              <span>数据时间：{formatKanbanDate(board.now)}</span>
            )}
          </div>
        )}
      </div>

      {/* Task detail */}
      {selectedTaskId && (
        <>
          {taskLoading && !taskDetail ? (
            <>
              <div className={s.detailOverlay} onClick={handleCloseDetail} aria-hidden="true" />
              <div className={s.detailDrawer} role="dialog" aria-modal="true" aria-label="正在加载任务详情">
                <div className={s.detailHeader}>
                  <div className={s.detailTitle}>任务详情</div>
                  <button type="button" className={s.closeBtn} onClick={handleCloseDetail} aria-label="关闭">
                    <X size={20} />
                  </button>
                </div>
                <div className={s.detailBody}>
                  <div className={s.loading}>正在加载任务详情…</div>
                </div>
              </div>
            </>
          ) : taskError ? (
            <>
              <div className={s.detailOverlay} onClick={handleCloseDetail} aria-hidden="true" />
              <div className={s.detailDrawer} role="dialog" aria-modal="true" aria-label="任务加载失败">
                <div className={s.detailHeader}>
                  <div className={s.detailTitle}>加载失败</div>
                  <button type="button" className={s.closeBtn} onClick={handleCloseDetail} aria-label="关闭">
                    <X size={20} />
                  </button>
                </div>
                <div className={s.detailBody}>
                  <div className={s.errorBox} role="alert">{taskError}</div>
                </div>
              </div>
            </>
          ) : (
            <TaskDetail task={taskDetail} onClose={handleCloseDetail} />
          )}
        </>
      )}
    </SectionShell>
  );
}
