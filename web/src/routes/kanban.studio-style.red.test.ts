import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname ?? __dirname;
const tsx = readFileSync(resolve(dir, "kanban.tsx"), "utf-8");
const css = readFileSync(resolve(dir, "kanban.module.css"), "utf-8");

describe("RED: Hermes Studio kanban visual structure", () => {
  it("renders the Studio card hierarchy: heading/status marker, body, footer, assignee and relative time", () => {
    expect(tsx).toContain("s.cardHeading");
    expect(tsx).toContain("s.statusMarker");
    expect(tsx).toContain("s.cardFooter");
    expect(tsx).toContain("s.assigneeAvatar");
    expect(tsx).toContain("formatRelativeTime");
  });

  it("uses Studio-like rounded neutral columns and elevated task cards", () => {
    expect(css).toMatch(/\.column\s*\{[\s\S]*border:\s*1px solid[\s\S]*border-radius:/);
    expect(css).toMatch(/\.taskCard\s*\{[\s\S]*border-radius:[\s\S]*box-shadow:/);
    expect(css).toContain(".cardHeading");
    expect(css).toContain(".cardFooter");
    expect(css).toContain(".statusMarker");
  });
});
