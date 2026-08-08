import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname ?? __dirname;
const tsx = readFileSync(resolve(dir, "kanban.tsx"), "utf-8");
const css = readFileSync(resolve(dir, "kanban.module.css"), "utf-8");

describe("Kanban TaskCard structure: priorities and assignee", () => {
  it("renders priority with data-priority attribute for conditional styling", () => {
    expect(tsx).toContain("data-priority={task.priority}");
  });

  it("handles missing assignee gracefully (no crash, no empty avatar)", () => {
    // The assignee section is conditionally rendered
    expect(tsx).toContain("task.assignee ?");
    expect(tsx).toContain("s.assigneeAvatar");
  });

  it("shows first letter of assignee as avatar", () => {
    expect(tsx).toContain("task.assignee.charAt(0).toUpperCase()");
  });

  it("renders status marker with dynamic color from STATUS_COLORS", () => {
    expect(tsx).toContain("STATUS_COLORS[task.status]");
    expect(tsx).toContain("s.statusMarker");
  });

  it("renders formatRelativeTime for task timestamps", () => {
    expect(tsx).toContain("formatRelativeTime(task.completed_at");
  });
});

describe("Kanban CSS: Studio visual tokens", () => {
  it("column has rounded corners and border", () => {
    expect(css).toMatch(/\.column\s*\{[\s\S]*border:\s*1px solid[\s\S]*border-radius:\s*\d+px/);
  });

  it("taskCard has rounded corners and box-shadow", () => {
    expect(css).toMatch(/\.taskCard\s*\{[\s\S]*border-radius:\s*\d+px[\s\S]*box-shadow:/);
  });

  it("cardHeading, statusMarker, cardFooter, assigneeAvatar are all defined", () => {
    expect(css).toContain(".cardHeading");
    expect(css).toContain(".statusMarker");
    expect(css).toContain(".cardFooter");
    expect(css).toContain(".assigneeAvatar");
  });

  it("hover effect includes border color mix and translateY", () => {
    expect(css).toMatch(/\.taskCard:hover[\s\S]*color-mix/);
    expect(css).toMatch(/\.taskCard:hover[\s\S]*translateY/);
  });

  it("respects prefers-reduced-motion", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("mobile detail drawer is full width at ≤720px", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.detailDrawer[\s\S]*width:\s*100vw/);
  });

  it("detailFields goes single column on mobile", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.detailFields[\s\S]*grid-template-columns:\s*1fr/);
  });
});
