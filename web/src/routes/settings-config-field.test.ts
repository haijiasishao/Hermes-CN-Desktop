import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(import.meta.dirname ?? __dirname);
const tsxSource = readFileSync(resolve(srcDir, "settings.tsx"), "utf-8");
const cssSource = readFileSync(resolve(srcDir, "settings.module.css"), "utf-8");

describe("configuration fields – structured value and narrow layout", () => {
  it("uses dedicated structured-value and row classes", () => {
    expect(tsxSource).toContain("s.configFieldRow");
    expect(tsxSource).toContain("s.configStructuredValue");
    expect(tsxSource).toContain("s.configStructuredEditor");
  });

  it("stacks config rows and constrains their controls on narrow screens", () => {
    expect(cssSource).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.configFieldRow\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(cssSource).toMatch(/\.configFieldRow \.rowRight\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
    expect(cssSource).toMatch(/\.configStructuredValue\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(cssSource).toMatch(/\.configStructuredEditor\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
    expect(cssSource).toMatch(/\.configStructuredEditor\s*\{[\s\S]*?max-height:\s*60vh[\s\S]*?overflow-y:\s*auto/);
  });
});
