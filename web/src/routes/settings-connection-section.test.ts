import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve relative to the web/ project root (vitest cwd).
const srcDir = resolve(import.meta.dirname ?? __dirname);
const tsxPath = resolve(srcDir, "settings-connection-section.tsx");
const cssPath = resolve(srcDir, "settings.module.css");

const tsxSource = readFileSync(tsxPath, "utf-8");
const cssSource = readFileSync(cssPath, "utf-8");

describe("connection section – responsive mobile layout", () => {
  it("TSX uses connRow class on the three connection form rows", () => {
    // Remote URL row, token row, gated login row
    const connRowMatches = tsxSource.match(/s\.connRow/g) ?? [];
    // At minimum 3 occurrences: remote URL, token, and gated login rows
    // (plus any className={`${s.row} ${s.connRow}`})
    expect(connRowMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("TSX uses connControl class on URL, token, and password inputs", () => {
    const connControlMatches = tsxSource.match(/s\.connControl/g) ?? [];
    // 5 occurrences: remote URL input, token input, pwUser, pwPass, plus className usage
    expect(connControlMatches.length).toBeGreaterThanOrEqual(4);
  });

  it("TSX uses connAuthControls on the gated-login rowRight", () => {
    expect(tsxSource).toContain("s.connAuthControls");
  });

  it("TSX uses connPasswordControls on password provider wrappers", () => {
    expect(tsxSource).toContain("s.connPasswordControls");
  });

  it("TSX no longer contains inline minWidth: 280", () => {
    expect(tsxSource).not.toContain("minWidth: 280");
    expect(tsxSource).not.toContain('min-width: 280');
  });

  it("CSS defines desktop defaults for connRow", () => {
    expect(cssSource).toContain(".connRow");
    expect(cssSource).toContain(".connRow .rowRight");
    expect(cssSource).toMatch(/\.connRow\s*\{[^}]*align-items:\s*flex-start/);
  });

  it("CSS defines connControl with width: 100% and min-width: 0", () => {
    expect(cssSource).toContain(".connControl");
    expect(cssSource).toMatch(/\.connControl\s*\{[^}]*width:\s*100%/);
    expect(cssSource).toMatch(/\.connControl\s*\{[^}]*min-width:\s*0/);
  });

  it("CSS stacks connRow vertically at ≤720px", () => {
    // Find the mobile media query block and verify connRow stacks
    const mobileBlock = cssSource.match(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.connRow\s*\{[\s\S]*?flex-direction:\s*column/,
    );
    expect(mobileBlock).toBeTruthy();
  });

  it("CSS makes connControl full-width at ≤720px", () => {
    const mobileBlock = cssSource.match(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.connControl\s*\{[\s\S]*?width:\s*100%/,
    );
    expect(mobileBlock).toBeTruthy();
  });

  it("CSS defines connAuthControls and connPasswordControls with box-sizing: border-box", () => {
    expect(cssSource).toMatch(/\.connAuthControls\s*\{[^}]*box-sizing:\s*border-box/);
    expect(cssSource).toMatch(/\.connPasswordControls\s*\{[^}]*box-sizing:\s*border-box/);
  });
});
