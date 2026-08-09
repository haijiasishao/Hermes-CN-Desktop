import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesResponse, SearchResult, SessionsResponse, SessionSummary } from "@hermes/protocol";
import { fetchJSON } from "@/lib/transport";
import {
  deleteSessionsInBatches,
  fetchSessionMessages,
  resolveSessionListLimit,
  sessionListErrorMessage,
  withoutSearchResults,
  withoutSessions,
} from "./use-sessions";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  deleteJSON: vi.fn(),
  postJSON: vi.fn(),
}));

const mockFetchJSON = fetchJSON as unknown as ReturnType<typeof vi.fn>;

function session(id: string): SessionSummary {
  return {
    id,
    model: "model",
    title: id,
    started_at: 1,
    ended_at: 2,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function sessionsResponse(ids: string[]): SessionsResponse {
  return {
    sessions: ids.map(session),
    total: ids.length,
    limit: 50,
    offset: 0,
  };
}

function searchResult(id: string): SearchResult {
  return {
    session_id: id,
    snippet: id,
  };
}

describe("session list error messages", () => {
  it("turns a gated Dashboard no_cookie response into a re-login instruction", () => {
    expect(sessionListErrorMessage(new Error('HTTP 401: {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}')))
      .toContain("重新登录");
  });

  it("keeps generic Dashboard failures distinguishable from authentication failures", () => {
    expect(sessionListErrorMessage(new Error("HTTP 502: upstream unavailable")))
      .toBe("无法加载会话列表，请检查 Dashboard 服务。");
  });
});

describe("session list pagination boundary", () => {
  it("caps oversized Android Remote requests while preserving desktop callers", () => {
    expect(resolveSessionListLimit(200, true)).toBe(50);
    expect(resolveSessionListLimit(50, true)).toBe(50);
    expect(resolveSessionListLimit(200, false)).toBe(200);
  });
});

describe("session cache delete helpers", () => {
  it("removes several sessions and updates total", () => {
    const result = withoutSessions(sessionsResponse(["s1", "s2", "s3"]), ["s1", "s3"]);

    expect(result?.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(result?.total).toBe(1);
  });

  it("removes matching search results", () => {
    const result = withoutSearchResults(
      { results: ["s1", "s2", "s3"].map(searchResult) },
      ["s2", "missing"],
    );

    expect(result?.results.map((item) => item.session_id)).toEqual(["s1", "s3"]);
  });
});

describe("deleteSessionsInBatches", () => {
  it("deduplicates ids and reports successful deletes", async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined);

    const result = await deleteSessionsInBatches(["s1", "s2", "s1", " "], deleteOne, 2);

    expect(deleteOne).toHaveBeenCalledTimes(2);
    expect(result.requestedIds).toEqual(["s1", "s2"]);
    expect(result.succeededIds).toEqual(["s1", "s2"]);
    expect(result.failed).toEqual([]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("keeps partial failures visible to callers", async () => {
    const deleteOne = vi.fn(async (id: string) => {
      if (id === "s2") throw new Error("boom");
    });

    const result = await deleteSessionsInBatches(["s1", "s2", "s3"], deleteOne, 3);

    expect(result.succeededIds).toEqual(["s1", "s3"]);
    expect(result.failed).toEqual([{ id: "s2", error: "boom" }]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
  });
});

describe("fetchSessionMessages 历史回退", () => {
  const primary = (id: string) => `/api/sessions/${id}/messages`;
  const sessionLog = (id: string) => `/__hermes_session_log/${encodeURIComponent(id)}`;

  function withMessages(id: string, count: number): MessagesResponse {
    return {
      session_id: id,
      messages: Array.from({ length: count }, () => ({})),
    } as unknown as MessagesResponse;
  }

  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  it("主端点 404 时回退到会话日志读取，历史不丢", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s1")) throw new Error("HTTP 404: not found");
      if (path === sessionLog("s1")) return withMessages("s1", 2);
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionMessages("s1");

    expect(result.messages).toHaveLength(2);
  });

  it("主端点 404 且会话日志也为空时抛出原始错误", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s2")) throw new Error("HTTP 404: not found");
      if (path === sessionLog("s2")) return withMessages("s2", 0);
      throw new Error(`unexpected ${path}`);
    });

    await expect(fetchSessionMessages("s2")).rejects.toThrow("HTTP 404");
  });

  it("abort 错误直接抛出，不触发回退", async () => {
    const abort = new DOMException("aborted", "AbortError");
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s3")) throw abort;
      throw new Error(`unexpected fallback ${path}`);
    });

    await expect(fetchSessionMessages("s3")).rejects.toBe(abort);
    expect(mockFetchJSON).toHaveBeenCalledTimes(1);
  });

  it("主端点成功但为空时仍回退（保持既有行为）", async () => {
    mockFetchJSON.mockImplementation(async (path: string) => {
      if (path === primary("s4")) return withMessages("s4", 0);
      if (path === sessionLog("s4")) return withMessages("s4", 3);
      throw new Error(`unexpected ${path}`);
    });

    const result = await fetchSessionMessages("s4");

    expect(result.messages).toHaveLength(3);
  });
});

// ── Android Remote: skip /__hermes_session_log fallback ────────────────
// On Android Remote, the local session-log endpoint does not exist (404).
// fetchSessionMessages should surface the primary endpoint error directly
// instead of attempting the fallback and producing a second 404.
describe("fetchSessionMessages Android Remote skip", () => {
  beforeEach(() => {
    mockFetchJSON.mockReset();
  });

  // Inline import to get the runtime reference used by the module.
  // We mock window.__HERMES_RUNTIME__ before calling fetchSessionMessages.
  it("skips session-log fallback when androidRemoteOnly is true", async () => {
    const orig = (globalThis as any).__HERMES_RUNTIME__;
    (globalThis as any).__HERMES_RUNTIME__ = { androidRemoteOnly: true };
    try {
      mockFetchJSON.mockImplementation(async () => {
        throw new Error("HTTP 404: not found");
      });
      await expect(fetchSessionMessages("a1")).rejects.toThrow("HTTP 404: not found");
      // Should only call the primary endpoint, not the fallback
      expect(mockFetchJSON).toHaveBeenCalledTimes(1);
      expect(mockFetchJSON.mock.calls[0][0]).toContain("/api/sessions/a1/messages");
    } finally {
      if (orig === undefined) delete (globalThis as any).__HERMES_RUNTIME__;
      else (globalThis as any).__HERMES_RUNTIME__ = orig;
    }
  });

  it("still uses fallback when androidRemoteOnly is false", async () => {
    const orig = (globalThis as any).__HERMES_RUNTIME__;
    (globalThis as any).__HERMES_RUNTIME__ = { androidRemoteOnly: false };
    try {
      mockFetchJSON.mockImplementation(async (path: string) => {
        if (path.includes("/api/sessions/")) throw new Error("HTTP 404");
        if (path.includes("/__hermes_session_log/")) {
          return { session_id: "a2", messages: [{ id: 1 }] } as unknown as MessagesResponse;
        }
        throw new Error("unexpected");
      });
      const result = await fetchSessionMessages("a2");
      expect(result.messages).toHaveLength(1);
      expect(mockFetchJSON).toHaveBeenCalledTimes(2);
    } finally {
      if (orig === undefined) delete (globalThis as any).__HERMES_RUNTIME__;
      else (globalThis as any).__HERMES_RUNTIME__ = orig;
    }
  });
});
