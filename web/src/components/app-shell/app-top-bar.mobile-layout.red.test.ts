import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname ?? __dirname;
const css = readFileSync(resolve(dir, "app-top-bar.module.css"), "utf-8");
const tsx = readFileSync(resolve(dir, "app-top-bar.tsx"), "utf-8");

// ── helpers ──────────────────────────────────────────────────────────

/** Extract the inner declarations of a named rule block inside a media query.
 *  Returns null when the rule or media block is absent. */
function ruleInsideMedia(
  source: string,
  mediaPattern: RegExp,
  ruleSelector: string, // e.g. ".topbar" — a plain CSS class selector
): string | null {
  const mediaIdx = source.search(mediaPattern);
  if (mediaIdx === -1) return null;

  const fromMedia = source.slice(mediaIdx);

  // Escape the selector for a JS regex literal
  const escapedSel = ruleSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleRe = new RegExp(escapedSel + "\\s*\\{");
  const ruleMatch = ruleRe.exec(fromMedia);
  if (!ruleMatch) return null;

  const afterOpen = fromMedia.slice(ruleMatch.index + ruleMatch[0].length);
  // Extract until matching closing brace
  let depth = 1;
  let i = 0;
  for (; i < afterOpen.length && depth > 0; i++) {
    if (afterOpen[i] === "{") depth++;
    else if (afterOpen[i] === "}") depth--;
  }
  return afterOpen.slice(0, i - 1);
}

// ── REGRESSION: mobile actions area must be pinned, not scrolled with nav ───

describe("REGRESSION: mobile topbar — actions pinned right, nav scrolls independently", () => {
  const mobileMedia = /@media\s*\(max-width:\s*720px\)/;

  it("mobile .topbar must NOT have overflow-x: auto (that scrolls all children together)", () => {
    // The topbar itself should not be the scroll container; the nav
    // should be. If the topbar scrolls, the actions (theme button)
    // scroll off-screen when the user swipes through nav tabs.
    const topbarDecl = ruleInsideMedia(css, mobileMedia, ".topbar");
    expect(topbarDecl).toBeTruthy();
    expect(topbarDecl!).not.toMatch(/overflow-x:\s*auto/);
  });

  it("mobile .nav must have overflow-x: auto so it scrolls independently", () => {
    // The nav is the primary scrollable area; it must own the horizontal
    // overflow so that actions stay pinned to the right edge.
    const navDecl = ruleInsideMedia(css, mobileMedia, ".nav");
    expect(navDecl).toBeTruthy();
    expect(navDecl!).toMatch(/overflow-x:\s*auto/);
  });

  it("mobile .actions must have position: sticky and right: 0 to stay at the right edge", () => {
    // position: sticky + right: 0 keeps the actions area pinned while
    // the nav scrolls. Without this, actions slide off-screen on swipe.
    const actionsDecl = ruleInsideMedia(css, mobileMedia, ".actions");
    expect(actionsDecl).toBeTruthy();
    expect(actionsDecl!).toMatch(/position:\s*sticky/);
    expect(actionsDecl!).toMatch(/right:\s*0/);
  });

  it("theme button preserves aria-label for accessibility", () => {
    // Guard the existing accessible label contract on the theme toggle.
    expect(tsx).toMatch(/aria-label=\{themeToggleLabel\}/);
  });

  it("nav area has aria-label for screen readers", () => {
    expect(tsx).toContain('aria-label="主导航"');
  });
});
