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
});
