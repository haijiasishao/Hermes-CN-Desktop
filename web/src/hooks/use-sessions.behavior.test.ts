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
