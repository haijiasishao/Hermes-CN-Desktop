import { describe, expect, it, vi } from "vitest";
import {
  STATUS_ORDER,
  STATUS_LABELS,
  STATUS_COLORS,
  normalizeBoardColumns,
  normalizeTask,
  normalizePriority,
  normalizeDateValue,
  parseHttpError,
  formatKanbanDate,
  selectKanbanStatus,
  kanbanErrorToChinese,
  isStatusSelectorPreferred,
  type KanbanBoardResponse,
  type KanbanTask,
} from "./kanban";
import { fetchJSON } from "./transport";

vi.mock("./transport", () => ({
  fetchJSON: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t-001",
    title: "修复登录按钮",
    status: "todo",
    priority: "high",
    assignee: "alice",
    created_at: "2026-01-10T08:00:00Z",
    started_at: null,
    completed_at: null,
    description: "按钮在小屏上不可见",
    ...overrides,
  };
}

function makeBoardResponse(columns?: KanbanBoardResponse["columns"]): KanbanBoardResponse {
  return {
    columns: columns ?? [
      { name: "todo", tasks: [makeTask(), makeTask({ id: "t-002", title: "优化首页" })] },
      { name: "done", tasks: [makeTask({ id: "t-003", title: "部署完成", status: "done" })] },
      { name: "running", tasks: [] },
    ],
    tenants: ["default"],
    assignees: ["alice", "bob"],
    latest_event_id: "evt-99",
    now: "2026-08-08T10:00:00Z",
  };
}

/* ------------------------------------------------------------------ */
/* API-realistic fixtures (real Hermes API field names)                 */
/* ------------------------------------------------------------------ */

function makeApiTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "api-001",
    title: "修复登录 Bug",
    status: "todo",
    priority: 2,
    assignee: "alice",
    created_at: 1704873600,
    started_at: null,
    completed_at: null,
    body: "按钮在小屏上点击无反应",
    result: null,
    latest_summary: "已定位到 CSS 媒体查询问题",
    ...overrides,
  };
}

function makeApiBoardResponse(columns?: { name: string; tasks: Record<string, unknown>[] }[]) {
  return {
    columns: columns ?? [
      { name: "todo", tasks: [makeApiTask(), makeApiTask({ id: "api-002", title: "优化首页" })] },
      { name: "done", tasks: [makeApiTask({ id: "api-003", title: "部署完成", status: "done" })] },
      { name: "running", tasks: [] },
    ],
    tenants: ["default"],
    assignees: ["alice", "bob"],
    latest_event_id: "evt-99",
    now: "2026-08-08T10:00:00Z",
  };
}

function makeDetailWrapperResponse(task?: Record<string, unknown>) {
  return {
    task: task ?? makeApiTask({ body: "按钮在小屏上点击无反应", result: "已修复 CSS 问题" }),
    comments: [
      { author: "bob", body: "已确认复现", created_at: 1704960000 },
    ],
    events: [{ id: "evt-1", type: "status_change" }],
    attachments: [],
    links: [],
    child_results: [],
    runs: [{ id: "run-1", status: "success", started_at: 1704960000 }],
  };
}

/* ------------------------------------------------------------------ */
/* STATUS_ORDER 全局顺序                                               */
/* ------------------------------------------------------------------ */

describe("STATUS_ORDER", () => {
  it("contains all 9 canonical statuses in correct order", () => {
    expect(STATUS_ORDER).toEqual([
      "triage", "todo", "scheduled", "ready", "running",
      "blocked", "review", "done", "archived",
    ]);
  });

  it("every status has a label and a color", () => {
    for (const status of STATUS_ORDER) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_COLORS[status]).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* normalizeBoardColumns                                               */
/* ------------------------------------------------------------------ */

describe("normalizeBoardColumns", () => {
  it("returns columns grouped by status name preserving canonical order", () => {
    const board = makeBoardResponse([
      { name: "done", tasks: [makeTask({ id: "d1", status: "done" })] },
      { name: "todo", tasks: [makeTask({ id: "t1", status: "todo" })] },
      { name: "running", tasks: [makeTask({ id: "r1", status: "running" })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns.map((c) => c.name)).toEqual(["todo", "running", "done"]);
  });

  it("places unknown/extra column names at the end", () => {
    const board = makeBoardResponse([
      { name: "custom_sprint", tasks: [makeTask({ id: "x1" })] },
      { name: "todo", tasks: [makeTask({ id: "t1" })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].name).toBe("todo");
    expect(result.columns[result.columns.length - 1].name).toBe("custom_sprint");
  });

  it("handles empty columns gracefully", () => {
    const board = makeBoardResponse([]);
    const result = normalizeBoardColumns(board);
    expect(result.columns).toEqual([]);
  });

  it("wraps a null/undefined columns array into an empty array", () => {
    const board = { columns: null as unknown, tenants: [], assignees: [], latest_event_id: "", now: "" } as unknown as KanbanBoardResponse;
    const result = normalizeBoardColumns(board);
    expect(result.columns).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* normalizePriority                                                   */
/* ------------------------------------------------------------------ */

describe("normalizePriority", () => {
  it("converts 0 to normal", () => {
    expect(normalizePriority(0)).toBe("normal");
  });

  it("converts 1 to critical", () => {
    expect(normalizePriority(1)).toBe("critical");
  });

  it("converts 2 to high", () => {
    expect(normalizePriority(2)).toBe("high");
  });

  it("passes through string values", () => {
    expect(normalizePriority("medium")).toBe("medium");
  });

  it("converts 3+ to numeric string", () => {
    expect(normalizePriority(3)).toBe("3");
    expect(normalizePriority(5)).toBe("5");
  });

  it("defaults null/undefined to normal", () => {
    expect(normalizePriority(null)).toBe("normal");
    expect(normalizePriority(undefined)).toBe("normal");
  });
});

/* ------------------------------------------------------------------ */
/* normalizeDateValue                                                  */
/* ------------------------------------------------------------------ */

describe("normalizeDateValue", () => {
  it("preserves numeric values", () => {
    expect(normalizeDateValue(1704873600)).toBe(1704873600);
    expect(normalizeDateValue(1704873600000)).toBe(1704873600000);
  });

  it("preserves string values", () => {
    expect(normalizeDateValue("2024-01-10T08:00:00Z")).toBe("2024-01-10T08:00:00Z");
  });

  it("returns null for null/undefined/boolean", () => {
    expect(normalizeDateValue(null)).toBeNull();
    expect(normalizeDateValue(undefined)).toBeNull();
    expect(normalizeDateValue(true)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* parseHttpError                                                      */
/* ------------------------------------------------------------------ */

describe("parseHttpError", () => {
  it("extracts status from Error('HTTP 401: {...}')", () => {
    expect(parseHttpError(new Error('HTTP 401: {"error":"unauthorized"}'))).toBe(401);
  });

  it("extracts 500 from Error message", () => {
    expect(parseHttpError(new Error("HTTP 500: internal error"))).toBe(500);
  });

  it("extracts 403 from Error message", () => {
    expect(parseHttpError(new Error("HTTP 403: forbidden"))).toBe(403);
  });

  it("returns null for non-HTTP errors", () => {
    expect(parseHttpError(new Error("network timeout"))).toBeNull();
  });

  it("returns null for non-Error values", () => {
    expect(parseHttpError("HTTP 401")).toBeNull();
    expect(parseHttpError(401)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* normalizeTask                                                       */
/* ------------------------------------------------------------------ */

describe("normalizeTask", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeTask(null as unknown as Record<string, unknown>)).toBeNull();
    expect(normalizeTask(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it("extracts core fields with safe defaults", () => {
    const raw = {
      id: "t-100",
      title: "测试",
      status: "blocked",
      priority: "critical",
      assignee: "bob",
      created_at: "2026-07-01T00:00:00Z",
      started_at: "2026-07-02T00:00:00Z",
      completed_at: null,
      description: "详细描述",
      comments: [{ author: "alice", text: "LGTM", created_at: "2026-07-03T00:00:00Z" }],
      runs: [{ id: "run-1", status: "success", started_at: "2026-07-02T00:00:00Z" }],
      child_results: [],
      attachments: [],
      links: [],
      events: [],
    };
    const result = normalizeTask(raw);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("t-100");
    expect(result!.title).toBe("测试");
    expect(result!.status).toBe("blocked");
    expect(result!.priority).toBe("critical");
    expect(result!.assignee).toBe("bob");
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].author).toBe("alice");
    expect(result!.runs).toHaveLength(1);
  });

  it("handles missing optional fields with defaults", () => {
    const raw = { id: "t-minimal", title: "最少字段" };
    const result = normalizeTask(raw);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("todo");
    expect(result!.priority).toBe("normal");
    expect(result!.assignee).toBe("");
    expect(result!.comments).toEqual([]);
    expect(result!.runs).toEqual([]);
    expect(result!.description).toBe("");
  });

  it("wraps string description fallback when non-string", () => {
    const raw = { id: "t-bad", title: "X", description: 123 };
    const result = normalizeTask(raw);
    expect(result!.description).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* Real API board task normalization                                   */
/* ------------------------------------------------------------------ */

describe("normalizeBoardColumns – real API fields", () => {
  it("normalizes numeric priority to readable string", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ priority: 2 })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].priority).toBe("high");
  });

  it("preserves numeric epoch timestamps as numbers", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ created_at: 1704873600 })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].created_at).toBe(1704873600);
    expect(typeof result.columns[0].tasks[0].created_at).toBe("number");
  });

  it("normalizes body field to description", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ body: "任务正文" })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].description).toBe("任务正文");
  });

  it("normalizes latest_summary field", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ latest_summary: "最新进展摘要" })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].latest_summary).toBe("最新进展摘要");
  });

  it("normalizes result field", () => {
    const board = makeApiBoardResponse([
      { name: "done", tasks: [makeApiTask({ result: "完成结果", status: "done" })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].result).toBe("完成结果");
  });

  it("defaults numeric priority 0 to normal", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ priority: 0 })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].priority).toBe("normal");
  });

  it("handles mixed priority types across tasks", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [
        makeApiTask({ id: "p0", priority: 0 }),
        makeApiTask({ id: "p1", priority: 1 }),
        makeApiTask({ id: "p2", priority: 2 }),
        makeApiTask({ id: "pstr", priority: "high" }),
      ]},
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].priority).toBe("normal");
    expect(result.columns[0].tasks[1].priority).toBe("critical");
    expect(result.columns[0].tasks[2].priority).toBe("high");
    expect(result.columns[0].tasks[3].priority).toBe("high");
  });

  it("null timestamps become null", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ started_at: null, completed_at: null })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].started_at).toBeNull();
    expect(result.columns[0].tasks[0].completed_at).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Detail wrapper – comments.body normalization                        */
/* ------------------------------------------------------------------ */

describe("normalizeTask – detail wrapper comments", () => {
  it("normalizes comment body field to text for UI consumption", () => {
    const raw = makeDetailWrapperResponse();
    const task = normalizeTask(raw.task as Record<string, unknown>);
    expect(task).not.toBeNull();
    // Direct call on inner task: inner task has no comments field,
    // so comments should be empty.
    expect(task!.comments).toEqual([]);
  });

  it("fetchKanbanTask merges wrapper comments with body-to-text mapping", async () => {
    // fetchKanbanTask should unwrap {task, comments, ...} and map body→text
    const raw = makeDetailWrapperResponse();
    const kanban = await import("./kanban");
    vi.mocked(fetchJSON).mockResolvedValue(raw as never);
    try {
      const result = await kanban.fetchKanbanTask("api-001");
      expect(result).not.toBeNull();
      expect(result!.comments).toHaveLength(1);
      expect(result!.comments[0].text).toBe("已确认复现");
      expect(result!.comments[0].author).toBe("bob");
    } finally {
      vi.mocked(fetchJSON).mockReset();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Stats – by_status object conversion                                 */
/* ------------------------------------------------------------------ */

describe("fetchKanbanStats – by_status normalization", () => {
  it("converts by_status object and derives total", async () => {
    const raw = { by_status: { todo: 5, done: 3 }, by_assignee: { alice: 8 } };
    const kanban = await import("./kanban");
    vi.mocked(fetchJSON).mockResolvedValue(raw as never);
    try {
      const stats = await kanban.fetchKanbanStats();
      expect(stats.by_status).toEqual({ todo: 5, done: 3 });
      expect(stats.total).toBe(8);
    } finally {
      vi.mocked(fetchJSON).mockReset();
    }
  });

  it("uses top-level total when present", async () => {
    const raw = { by_status: { todo: 5, done: 3 }, total: 10 };
    const kanban = await import("./kanban");
    vi.mocked(fetchJSON).mockResolvedValue(raw as never);
    try {
      const stats = await kanban.fetchKanbanStats();
      expect(stats.total).toBe(10);
    } finally {
      vi.mocked(fetchJSON).mockReset();
    }
  });

  it("handles missing by_status gracefully", async () => {
    const raw = {};
    const kanban = await import("./kanban");
    vi.mocked(fetchJSON).mockResolvedValue(raw as never);
    try {
      const stats = await kanban.fetchKanbanStats();
      expect(stats.by_status).toEqual({});
      expect(stats.total).toBe(0);
    } finally {
      vi.mocked(fetchJSON).mockReset();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Error("HTTP 401: ...") → Chinese message                            */
/* ------------------------------------------------------------------ */

describe("kanbanErrorToChinese – Error message with HTTP status", () => {
  it("parses Error('HTTP 401: {...}') as authentication expired", () => {
    expect(kanbanErrorToChinese(new Error('HTTP 401: {"error":"unauthorized"}'))).toContain("认证");
  });

  it("parses Error('HTTP 403: ...') as permission denied", () => {
    expect(kanbanErrorToChinese(new Error("HTTP 403: forbidden"))).toContain("权限");
  });

  it("parses Error('HTTP 404: ...') as plugin not enabled", () => {
    expect(kanbanErrorToChinese(new Error("HTTP 404: not found"))).toContain("未启用");
  });

  it("parses Error('HTTP 500: ...') as server error", () => {
    expect(kanbanErrorToChinese(new Error("HTTP 500: internal error"))).toContain("服务器");
  });
});

/* ------------------------------------------------------------------ */
/* Missing/abnormal column and task fields                             */
/* ------------------------------------------------------------------ */

describe("normalizeBoardColumns – missing/abnormal fields", () => {
  it("handles columns with tasks missing id and title", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [{ status: "todo" }] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe("todo");
  });

  it("handles tasks with all null/undefined fields", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [
        { id: null, title: undefined, status: null, priority: undefined, assignee: null,
          created_at: undefined, started_at: null, completed_at: undefined,
          body: null, result: undefined, latest_summary: null },
      ]},
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns).toHaveLength(1);
    const task = result.columns[0].tasks[0];
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("normal");
    expect(task.description).toBe("");
  });

  it("handles tasks with undefined timestamps", () => {
    const board = makeApiBoardResponse([
      { name: "todo", tasks: [makeApiTask({ created_at: undefined, started_at: undefined })] },
    ]);
    const result = normalizeBoardColumns(board);
    expect(result.columns[0].tasks[0].created_at).toBeNull();
    expect(result.columns[0].tasks[0].started_at).toBeNull();
  });

  it("normalizes empty columns array safely", () => {
    const board = makeApiBoardResponse([]);
    const result = normalizeBoardColumns(board);
    expect(result.columns).toEqual([]);
  });

  it("normalizes null columns to empty array", () => {
    const board = { columns: null, tenants: [], assignees: [], latest_event_id: "", now: "" };
    const result = normalizeBoardColumns(board as unknown as KanbanBoardResponse);
    expect(result.columns).toEqual([]);
  });
});

describe("normalizeTask – missing/abnormal fields", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeTask(null as unknown as Record<string, unknown>)).toBeNull();
    expect(normalizeTask(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it("uses safe defaults for task with only id", () => {
    const raw = { id: "t-minimal" };
    const result = normalizeTask(raw);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("todo");
    expect(result!.priority).toBe("normal");
    expect(result!.assignee).toBe("");
    expect(result!.comments).toEqual([]);
    expect(result!.runs).toEqual([]);
    expect(result!.description).toBe("");
    expect(result!.latest_summary).toBeNull();
    expect(result!.result).toBeNull();
  });

  it("wraps string description fallback when non-string", () => {
    const raw = { id: "t-bad", title: "X", description: 123 };
    const result = normalizeTask(raw);
    expect(result!.description).toBe("");
  });

  it("handles non-string body as empty description", () => {
    const raw = { id: "t-bad2", title: "Y", body: 123 };
    const result = normalizeTask(raw);
    expect(result!.description).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* kanbanErrorToChinese                                                */
/* ------------------------------------------------------------------ */

describe("kanbanErrorToChinese", () => {
  it("translates 401 to authentication expired message", () => {
    expect(kanbanErrorToChinese(401)).toContain("认证");
  });

  it("translates 403 to permission denied message", () => {
    expect(kanbanErrorToChinese(403)).toContain("权限");
  });

  it("translates 404 to plugin-not-enabled message", () => {
    expect(kanbanErrorToChinese(404)).toContain("未启用");
  });

  it("translates network/TypeError to offline message", () => {
    expect(kanbanErrorToChinese(new TypeError("Failed to fetch"))).toContain("网络");
  });

  it("translates unknown errors to generic message", () => {
    expect(kanbanErrorToChinese(new Error("weird"))).toContain("未知");
  });

  it("translates 500 to server error", () => {
    expect(kanbanErrorToChinese(500)).toContain("服务器");
  });
});

/* ------------------------------------------------------------------ */
/* isStatusSelectorPreferred                                           */
/* ------------------------------------------------------------------ */

describe("isStatusSelectorPreferred", () => {
  it("prefers status selector on narrow screens (< 720px)", () => {
    expect(isStatusSelectorPreferred(390)).toBe(true);
    expect(isStatusSelectorPreferred(719)).toBe(true);
  });

  it("prefers multi-column layout on wide screens (>= 720px)", () => {
    expect(isStatusSelectorPreferred(720)).toBe(false);
    expect(isStatusSelectorPreferred(1280)).toBe(false);
  });
});

describe("formatKanbanDate", () => {
  it("formats Unix epoch seconds instead of dropping them", () => {
    expect(formatKanbanDate(1704873600)).not.toBe("—");
  });

  it("returns an em dash for missing or invalid values", () => {
    expect(formatKanbanDate(null)).toBe("—");
    expect(formatKanbanDate("not-a-date")).toBe("—");
  });
});

describe("selectKanbanStatus", () => {
  const columns = [{ name: "running" }, { name: "done" }];

  it("keeps the current status when it exists", () => {
    expect(selectKanbanStatus(columns, "done")).toBe("done");
  });

  it("falls back to the first returned column when current status is absent", () => {
    expect(selectKanbanStatus(columns, "todo")).toBe("running");
  });

  it("returns an empty status for an empty board", () => {
    expect(selectKanbanStatus([], "todo")).toBe("");
  });
});
