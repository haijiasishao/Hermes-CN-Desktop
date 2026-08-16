import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "use-sessions.ts"),
  "utf-8",
);

describe("useSessions: archived query parameter alignment", () => {
  it("uses archived=include for the server-side parameter when includeArchived is true", () => {
    // The server now expects archived=include instead of include_archived=true
    expect(source).toContain("archived=include");
  });

  it("does not use deprecated include_archived parameter", () => {
    // The old include_archived parameter should be replaced
    expect(source).not.toContain("include_archived=true");
  });
});

const historySource = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "../routes/history.tsx"),
  "utf-8",
);

describe("History component behavior", () => {
  // Test 1: verify the component source uses useIsMobile for responsive layout
  it("uses useIsMobile hook for responsive layout", () => {
    expect(historySource).toContain("useIsMobile");
  });

  // Test 2: verify clicking a card sets selectedId (not navigate)
  it("uses selectedId state for card selection without navigation on click", () => {
    expect(historySource).toMatch(/selectedId|setSelectedId/);
    expect(historySource).toContain('data-selected');
  });

  // Test 3: verify "打开会话" button navigates to /tasks/
  it("has an open-session button that navigates to /tasks/", () => {
    expect(historySource).toContain('/tasks/');
  });

  // Test 4: verify message detail uses useSessionMessages
  it("uses useSessionMessages for message preview in detail panel", () => {
    expect(historySource).toContain('useSessionMessages');
  });

  // Regression: Android-only History baseline (PAGE_SIZE + conditional + RecentTable)
  describe("Android Remote-only regression", () => {
    it("retains PAGE_SIZE = 200 for the desktop path (no global change)", () => {
      // Desktop implementation is unchanged; PAGE_SIZE stays at 200
      expect(historySource).toContain("const PAGE_SIZE = 200");
    });

    it("branches on runtime.androidRemoteOnly for mobile-specific rendering", () => {
      // The Android path must be gated by a clear runtime flag, not a blanket PAGE_SIZE change
      expect(historySource).toMatch(/runtime\.androidRemoteOnly/);
    });

    it("imports and uses RecentTable for the Android compact list", () => {
      // Android uses a dedicated compact component instead of the full desktop table
      expect(historySource).toMatch(/import.*RecentTable/);
      expect(historySource).toMatch(/<RecentTable[\s/>]/);
    });

    it("calls useSessions() without arguments on the Android path (reuses default limit=50)", () => {
      // Android baseline reuses the workbench default limit=50 by calling useSessions() with no params
      expect(historySource).toMatch(/useSessions\(\s*\)/);
    });
  });
});

// ── fetchSessionMessages URL encoding ────────────────────────────────
describe("fetchSessionMessages: primary URL encoding", () => {
  it("encodes the session id in the primary /api/sessions/{id}/messages URL", () => {
    // Android Remote session IDs may contain special characters (e.g. slashes,
    // colons, percent-encoded bytes from the dashboard). The primary fetch URL
    // must use encodeURIComponent so the path segment is not misinterpreted.
    // The local fallback (__hermes_session_log) already encodes; the primary
    // must match that behavior.
    expect(source).toMatch(/\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/messages/);
  });

  it("keeps the fallback __hermes_session_log URL encoded as well", () => {
    expect(source).toMatch(/__hermes_session_log\/\$\{encodeURIComponent\(id\)\}/);
  });
});

// ── useSession URL encoding ──────────────────────────────────────
describe("useSession: detail URL encoding", () => {
  it("encodes the session id in /api/sessions/{id} with encodeURIComponent", () => {
    expect(source).toMatch(/\/api\/sessions\/\$\{encodeURIComponent\(id!?\)\}/);
  });
});

describe("Android detail submit foreground diagnostic contract", () => {
  it("starts the persistent task foreground monitor before sending and stops it on prepare/send failure", () => {
    expect(detailSource).toMatch(/import[\s\S]*startAndroidSessionForeground[\s\S]*from ["']@\/lib\/android-session-foreground["']/);
    expect(detailSource).toMatch(
      /const persistentSessionId = restSessionId \?\? resolvePersistentSessionId\(taskId\) \?\? taskId[\s\S]*persistentSessionId,[\s\S]*title:\s*["']后台链路诊断["'][\s\S]*state:\s*["']starting["']/,
    );
    expect(detailSource).not.toMatch(/persistentSessionId:\s*gatewaySessionId/);

    const start = detailSource.indexOf("startAndroidSessionForeground");
    const send = detailSource.indexOf("sendPrompt(gatewaySessionId");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(send);
    expect(detailSource).toMatch(
      /catch \(error\)[\s\S]{0,500}stopAndroidSessionForeground\(persistentSessionId\)[\s\S]{0,300}throw error/,
    );
  });
});

// ── DetailRoute: history-load error visibility ───────────────────────
const detailSource = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "../routes/detail.tsx"),
  "utf-8",
);

describe("DetailRoute: history-load error banner", () => {
  it("destructures isError from useSessionMessages query", () => {
    expect(detailSource).toMatch(/messagesQuery\b/);
    // isError must be extracted to detect query failure
    expect(detailSource).toMatch(/isError\b.*messagesQuery|messagesQuery\b[^;]*isError/);
  });

  it("destructures the error object from useSessionMessages query", () => {
    // The actual error text (401/404/parse) must be accessible for the banner
    expect(detailSource).toMatch(/\berror\b.*messagesQuery|messagesQuery\b[^;]*\berror\b/);
  });

  it("destructures refetch from useSessionMessages query for the retry button", () => {
    expect(detailSource).toMatch(/\brefetch\b.*messagesQuery|messagesQuery\b[^;]*\brefetch\b/);
  });

  it("renders a history-load error banner with the error text", () => {
    expect(detailSource).toMatch(/messages.*Error|messagesError|historyError/);
  });

  it("renders a retry button that calls refetch on click", () => {
    expect(detailSource).toMatch(/(?:重试|Retry)[\s\S]{0,200}refetchMessages|refetchMessages[\s\S]{0,200}(?:重试|Retry)/i);
  });

  it("does not block the composer when the history load fails", () => {
    // The error banner must not unmount GooseComposer or MessageTimeline
    expect(detailSource).toContain("GooseComposer");
    expect(detailSource).toContain("MessageTimeline");
  });
});

// ── Android History UI refinement ────────────────────────────────────
const historyCssSource = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "../routes/history.module.css"),
  "utf-8",
);

describe("Android History UI refinement", () => {
  it("passes compact prop to RecentTable in AndroidHistoryRoute", () => {
    expect(historySource).toMatch(/<RecentTable\s+compact/);
  });

  it("uses named CSS classes instead of inline styles for error rendering", () => {
    // The Android error block must use CSS classes, not style={{ ... }}
    expect(historySource).toContain("s.androidError");
    expect(historySource).toContain("s.androidErrorText");
    expect(historySource).toContain("s.androidActions");
  });

  it("renders a content wrapper for padded Android layout", () => {
    expect(historySource).toContain("s.androidContent");
  });

  it("shows a section hint for Android sessions", () => {
    expect(historySource).toContain("最近会话");
    expect(historySource).toContain("点击右侧三个点打开操作菜单");
  });

  it("has a coherent empty state for Android when no sessions exist", () => {
    expect(historySource).toContain("s.androidEmpty");
    expect(historySource).toContain("暂无会话");
    expect(historySource).toContain("s.androidEmptyHint");
  });

  it("uses androidBtn class for touch-friendly buttons", () => {
    expect(historySource).toContain("s.androidBtn");
  });

  it("defines androidBtn with >= 44px min-height for touch targets", () => {
    expect(historyCssSource).toMatch(/\.androidBtn[\s\S]*min-height:\s*44px/);
  });

  it("defines androidContent as a flex column layout", () => {
    expect(historyCssSource).toMatch(/\.androidContent[\s\S]*display:\s*flex/);
    expect(historyCssSource).toMatch(/\.androidContent[\s\S]*flex-direction:\s*column/);
  });
});
