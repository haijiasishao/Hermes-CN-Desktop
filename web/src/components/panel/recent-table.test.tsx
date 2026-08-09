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

  it("shows empty state in compact mode when sessions array is empty", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={[]} onOpen={() => {}} compact />,
    );
    expect(html).toContain("暂无会话");
  });

  it("renders compact card layout when compact prop is set", () => {
    const sessions = [makeSession()];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} compact />,
    );

    expect(html).not.toContain('data-label="ID"');
    expect(html).not.toContain('data-label="模型"');
    expect(html).not.toContain('data-label="Tokens"');

    expect(html).toContain("测试会话标题");
    expect(html).toContain("TUI");
    expect(html).toContain("已完成");
  });

  it("renders role=button and tabIndex on compact cards for keyboard activation", () => {
    const sessions = [makeSession()];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} compact />,
    );

    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });

  it("hides ID, model, and token fields in compact mode", () => {
    const sessions = [makeSession({ model: "gpt-4o" })];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} compact />,
    );

    expect(html).not.toContain("gpt-4o");
    expect(html).not.toContain("def456");
  });

  it("shows source label (not raw key) in compact mode", () => {
    const sessions = [makeSession({ source: "dashboard" })];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} compact />,
    );

    expect(html).toContain("Dashboard 嵌入");
  });

  it("shows error status in compact card title", () => {
    const sessions = [makeSession({ end_reason: "error" })];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} compact />,
    );

    expect(html).toContain("失败");
  });

  it("does not render compact layout when compact prop is omitted (default desktop)", () => {
    const sessions = [makeSession()];
    const html = ReactDOMServer.renderToStaticMarkup(
      <RecentTable sessions={sessions} onOpen={() => {}} />,
    );

    expect(html).toContain("table");
    expect(html).toContain('data-label="ID"');
  });
});

it("shows 进行中 for active session in compact mode, not 已完成", () => {
  const activeSession = makeSession({ ended_at: null, is_active: true });
  const html = ReactDOMServer.renderToStaticMarkup(
    <RecentTable sessions={[activeSession]} onOpen={() => {}} compact />,
  );

  expect(html).toContain("进行中");
  expect(html).not.toContain("已完成");
});

it("shows 进行中 for session with ended_at=null even without is_active in compact mode", () => {
  const noEndedAt = makeSession({ ended_at: null });
  const html = ReactDOMServer.renderToStaticMarkup(
    <RecentTable sessions={[noEndedAt]} onOpen={() => {}} compact />,
  );

  expect(html).toContain("进行中");
  expect(html).not.toContain("已完成");
});

it("keeps error/interrupted precedence over active state in compact mode", () => {
  const errorActive = makeSession({
    ended_at: null,
    is_active: true,
    end_reason: "error",
  });
  const html = ReactDOMServer.renderToStaticMarkup(
    <RecentTable sessions={[errorActive]} onOpen={() => {}} compact />,
  );

  // error takes precedence for status label
  expect(html).toContain("失败");
  // time area still shows active state
  expect(html).toContain("进行中");
  expect(html).not.toContain("已完成");
});
