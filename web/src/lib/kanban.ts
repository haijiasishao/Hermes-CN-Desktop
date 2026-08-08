import { fetchJSON } from "./transport";

/* ------------------------------------------------------------------ */
/* Canonical status constants                                         */
/* ------------------------------------------------------------------ */

/** Canonical ordering used across the UI. */
export const STATUS_ORDER = [
  "triage", "todo", "scheduled", "ready", "running",
  "blocked", "review", "done", "archived",
] as const;

export type KanbanStatus = (typeof STATUS_ORDER)[number];

/** Human-readable labels (Chinese). */
export const STATUS_LABELS: Record<string, string> = {
  triage: "待分类",
  todo: "待办",
  scheduled: "已排期",
  ready: "就绪",
  running: "执行中",
  blocked: "阻塞",
  review: "审查",
  done: "已完成",
  archived: "已归档",
};

/** Status → accent color (CSS custom property name or hex). */
export const STATUS_COLORS: Record<string, string> = {
  triage: "#9ca3af",
  todo: "#3b82f6",
  scheduled: "#8b5cf6",
  ready: "#06b6d4",
  running: "#f59e0b",
  blocked: "#ef4444",
  review: "#ec4899",
  done: "#22c55e",
  archived: "#6b7280",
};

/* ------------------------------------------------------------------ */
/* Normalizer helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalize a priority value from the API to a human-readable string.
 * The API returns integers: 0=default, 1=critical, 2=high, ≥3=numeric label.
 * Strings pass through unchanged.
 */
export function normalizePriority(value: unknown): string {
  if (typeof value === "number") {
    if (value === 0) return "normal";
    if (value === 1) return "critical";
    if (value === 2) return "high";
    return String(value);
  }
  if (typeof value === "string") return value;
  return "normal";
}

/**
 * Normalize a date/timestamp value. Numbers (Unix seconds or milliseconds)
 * and ISO strings pass through as-is; anything else becomes null.
 */
export function normalizeDateValue(value: unknown): string | number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  return null;
}

/**
 * Normalize body text: the API uses `body`, older UI used `description`.
 * Returns the first truthy string found, or empty string.
 */
function normalizeBody(raw: Record<string, unknown>): string {
  if (typeof raw.body === "string") return raw.body;
  if (typeof raw.description === "string") return raw.description;
  return "";
}

/**
 * Normalize latest summary / result text. Returns first truthy string or null.
 */
function normalizeLatestSummary(raw: Record<string, unknown>): string | null {
  if (typeof raw.latest_summary === "string" && raw.latest_summary) return raw.latest_summary;
  if (typeof raw.result === "string" && raw.result) return raw.result;
  return null;
}

/**
 * Parse an HTTP status code from an Error message like "HTTP 401: {...}".
 * Returns the status number or null.
 */
export function parseHttpError(err: unknown): number | null {
  if (err instanceof Error) {
    const match = err.message.match(/HTTP\s+(\d{3})/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* API response types                                                  */
/* ------------------------------------------------------------------ */

export interface KanbanTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  created_at: string | number | null;
  started_at: string | number | null;
  completed_at: string | number | null;
  description?: string;
  latest_summary?: string | null;
  result?: string | null;
  [key: string]: unknown;
}

export interface KanbanColumn {
  name: string;
  tasks: KanbanTask[];
}

export interface RawKanbanColumn {
  name?: unknown;
  tasks?: unknown[] | null;
}

export interface KanbanBoardResponse {
  columns?: RawKanbanColumn[] | null;
  tenants?: unknown;
  assignees?: unknown;
  latest_event_id?: string | number | null;
  now?: string | number | null;
}

export interface KanbanComment {
  author: string;
  text: string;
  created_at: string | number;
  [key: string]: unknown;
}

export interface KanbanRun {
  id: string;
  status: string;
  started_at: string | number;
  [key: string]: unknown;
}

export interface NormalizedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  created_at: string | number | null;
  started_at: string | number | null;
  completed_at: string | number | null;
  description: string;
  latest_summary: string | null;
  result: string | null;
  comments: KanbanComment[];
  runs: KanbanRun[];
  events: unknown[];
  attachments: unknown[];
  links: unknown[];
  child_results: unknown[];
  [key: string]: unknown;
}

export interface NormalizedBoard {
  columns: KanbanColumn[];
  tenants: string[];
  assignees: string[];
  latest_event_id: string | number | null;
  now: string | number | null;
}

export interface KanbanStats {
  by_status: Record<string, number>;
  total: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_INDEX = new Map<string, number>(
  STATUS_ORDER.map((s, i) => [s, i]),
);

function statusSortKey(name: string): number {
  return STATUS_INDEX.has(name) ? STATUS_INDEX.get(name)! : STATUS_ORDER.length;
}

/* ------------------------------------------------------------------ */
/* Normalizers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalize a raw board response: ensure columns array exists, sort by
 * canonical status order, unknown statuses go to the end.
 */
export function normalizeBoardColumns(board: KanbanBoardResponse): NormalizedBoard {
  const columns = (Array.isArray(board?.columns) ? board.columns : [])
    .filter((column): column is RawKanbanColumn => Boolean(column && typeof column === "object"))
    .map((column) => ({
      name: typeof column.name === "string" && column.name ? column.name : "todo",
      tasks: (Array.isArray(column.tasks) ? column.tasks : [])
        .map((task) => normalizeTask(task as unknown as Record<string, unknown>))
        .filter((task): task is NormalizedTask => task !== null),
    }));
  columns.sort((a, b) => statusSortKey(a.name) - statusSortKey(b.name));
  return {
    columns,
    tenants: Array.isArray(board?.tenants)
      ? board.tenants.filter((value): value is string => typeof value === "string")
      : [],
    assignees: Array.isArray(board?.assignees)
      ? board.assignees.filter((value): value is string => typeof value === "string")
      : [],
    latest_event_id: board?.latest_event_id ?? "",
    now: board?.now ?? "",
  };
}

/**
 * Normalize a raw task detail object. Returns null if input is not a
 * usable object.
 *
 * Handles real API field names:
 * - `body` (API) → `description` (UI) with `description` fallback
 * - `priority` integer → readable label
 * - timestamps as Unix seconds or ISO strings
 * - `latest_summary` and `result` carried through
 * - comment `body` → `text` for UI
 */
export function normalizeTask(raw: Record<string, unknown>): NormalizedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" ? raw.title : "";

  const rawComments = Array.isArray(raw.comments) ? raw.comments : [];
  const normalizedComments: KanbanComment[] = rawComments.map((value) => {
    const c = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      author: typeof c.author === "string" ? c.author : "",
      text: typeof c.text === "string" ? c.text : typeof c.body === "string" ? c.body : "",
      created_at: normalizeDateValue(c.created_at) ?? "",
    };
  });

  const rawRuns = Array.isArray(raw.runs) ? raw.runs : [];
  const normalizedRuns: KanbanRun[] = rawRuns.map((value) => {
    const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      id: typeof r.id === "string" ? r.id : "",
      status: typeof r.status === "string" ? r.status : "",
      started_at: normalizeDateValue(r.started_at) ?? "",
    };
  });

  return {
    id,
    title,
    status: typeof raw.status === "string" ? raw.status : "todo",
    priority: normalizePriority(raw.priority),
    assignee: typeof raw.assignee === "string" ? raw.assignee : "",
    created_at: normalizeDateValue(raw.created_at),
    started_at: normalizeDateValue(raw.started_at),
    completed_at: normalizeDateValue(raw.completed_at),
    description: normalizeBody(raw),
    latest_summary: normalizeLatestSummary(raw),
    result: typeof raw.result === "string" && raw.result ? raw.result : null,
    comments: normalizedComments,
    runs: normalizedRuns,
    events: Array.isArray(raw.events) ? raw.events : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    links: Array.isArray(raw.links) ? raw.links : [],
    child_results: Array.isArray(raw.child_results) ? raw.child_results : [],
  };
}

/* ------------------------------------------------------------------ */
/* Error → Chinese message                                             */
/* ------------------------------------------------------------------ */

/**
 * Convert a fetch/network error into a user-visible Chinese message.
 * Accepts an HTTP status number, or an Error/TypeError from fetch.
 * Handles Error("HTTP 401: {...}") patterns from fetchJSON.
 */
export function kanbanErrorToChinese(err: unknown): string {
  // First try to parse HTTP status from Error message (fetchJSON throws Error("HTTP NNN: ..."))
  const httpStatus = parseHttpError(err);
  if (httpStatus !== null) {
    return kanbanErrorToChinese(httpStatus);
  }

  if (typeof err === "number") {
    if (err === 401) return "认证已过期，请重新连接";
    if (err === 403) return "权限不足，无法访问看板数据";
    if (err === 404) return "看板插件未启用或接口不存在";
    if (err >= 500) return `服务器错误 (${err})，请稍后重试`;
    return `请求失败 (HTTP ${err})`;
  }

  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return "网络连接失败，请检查网络或后端状态";
  }

  if (err instanceof DOMException && err.name === "AbortError") {
    return "请求已取消";
  }

  return "未知错误，请重试";
}

/* ------------------------------------------------------------------ */
/* Responsive helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Returns true when the viewport is narrow enough that the mobile
 * status-selector / single-column layout should be used instead of
 * the multi-column kanban board. Breakpoint: 720px.
 */
export function isStatusSelectorPreferred(viewportWidth: number): boolean {
  return viewportWidth < 720;
}

/** Format API timestamps that may be Unix seconds, milliseconds, or ISO strings. */
export function formatKanbanDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  let dateValue: string | number = value;
  if (typeof value === "number") {
    dateValue = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  } else if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    dateValue = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Keep the current mobile column when possible, otherwise select the first API column. */
export function selectKanbanStatus(
  columns: Array<{ name: string }>,
  current: string,
): string {
  if (columns.some((column) => column.name === current)) return current;
  return columns[0]?.name ?? "";
}


/* ------------------------------------------------------------------ */
/* Fetch functions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch the kanban board. Returns a normalized board on success, or
 * throws with a human-readable error on failure.
 *
 * NOTE: When the backend's kanban plugin is not installed, the API
 * returns 404 — callers should catch and display via kanbanErrorToChinese.
 */
export async function fetchKanbanBoard(signal?: AbortSignal): Promise<NormalizedBoard> {
  const raw = await fetchJSON<KanbanBoardResponse>(
    "/api/plugins/kanban/board?include_archived=false",
    { signal },
  );
  return normalizeBoardColumns(raw);
}

/**
 * Fetch kanban stats (by-status counts).
 *
 * Handles the official API format: `{ by_status: {...}, by_assignee: {...}, ... }`
 * and legacy formats: wrapped `{ data: ... }` or flat `{ todo: 5, done: 3 }`.
 * Total is derived from by_status if not present at top level.
 */
export async function fetchKanbanStats(signal?: AbortSignal): Promise<KanbanStats> {
  const raw = await fetchJSON<Record<string, unknown>>(
    "/api/plugins/kanban/stats",
    { signal },
  );
  // Accept direct format or wrapped in `data`
  const payload = raw && typeof raw === "object" && "data" in raw
    ? (raw.data as Record<string, unknown>)
    : raw;

  let byStatus: Record<string, number> = {};

  if (payload && typeof payload === "object") {
    // Official format: { by_status: { todo: 5, ... }, by_assignee: {...}, ... }
    if ("by_status" in payload && typeof (payload as Record<string, unknown>).by_status === "object" && (payload as Record<string, unknown>).by_status !== null) {
      const rawByStatus = (payload as Record<string, Record<string, unknown>>).by_status;
      for (const [key, value] of Object.entries(rawByStatus)) {
        byStatus[key] = typeof value === "number" ? value : 0;
      }
    } else {
      // Legacy flat format: { todo: 5, done: 3, total: 8 }
      for (const [key, value] of Object.entries(payload)) {
        if (key === "total") continue;
        byStatus[key] = typeof value === "number" ? value : 0;
      }
    }
  }

  const total = typeof (payload as Record<string, unknown>)?.total === "number"
    ? (payload as Record<string, number>).total
    : Object.values(byStatus).reduce((s, n) => s + n, 0);

  return { by_status: byStatus, total };
}

/**
 * Fetch a single task detail. Returns a NormalizedTask or null.
 *
 * The API returns a wrapper: `{ task: {...}, comments, events, runs, ... }`.
 * Comments and runs from the wrapper are merged into the task before normalization.
 */
export async function fetchKanbanTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<NormalizedTask | null> {
  const raw = await fetchJSON<Record<string, unknown>>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  );
  // Handle wrapped response { task: {...}, comments, events, runs, ... }
  if (raw && typeof raw === "object" && "task" in raw && raw.task && typeof raw.task === "object") {
    const innerTask = raw.task as Record<string, unknown>;
    // Merge wrapper-level comments/runs/events/etc. into the task object
    const merged: Record<string, unknown> = {
      ...innerTask,
      comments: Array.isArray(raw.comments) ? raw.comments : innerTask.comments,
      runs: Array.isArray(raw.runs) ? raw.runs : innerTask.runs,
      events: Array.isArray(raw.events) ? raw.events : innerTask.events,
      attachments: Array.isArray(raw.attachments) ? raw.attachments : innerTask.attachments,
      links: Array.isArray(raw.links) ? raw.links : innerTask.links,
      child_results: Array.isArray(raw.child_results) ? raw.child_results : innerTask.child_results,
    };
    return normalizeTask(merged);
  }
  // Flat response (no wrapper)
  return normalizeTask(raw);
}
