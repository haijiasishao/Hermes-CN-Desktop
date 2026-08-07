import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { RecentTable } from "./recent-table";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "abc123def456",
    source: "tui",
    model: "claude-sonnet-4-20250514",
    title: "测试会话标题",
    preview: null,
    started_at: 1720000000,
    ended_at: 1720003600,
    end_reason: null,
    message_count: 5,
    input_tokens: 1200,
    output_tokens: 800,
    estimated_cost_usd: 0.01,
    ...overrides,
  } as SessionSummary;
}

describe("RecentTable", () => {
  it("renders data-label attributes on each td for mobile card layout", () => {
    const sessions = [makeSession()];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} />,
    );

    // All six data-label values must be present.
    expect(html).toContain('data-label="ID"');
    expect(html).toContain('data-label="标题"');
    expect(html).toContain('data-label="模型"');
    expect(html).toContain('data-label="来源"');
    expect(html).toContain('data-label="完成"');
    expect(html).toContain('data-label="Tokens"');
  });

  it("shows empty state when sessions array is empty", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={[]} onOpen={() => {}} />,
    );
    expect(html).toContain("暂无会话");
  });
});
