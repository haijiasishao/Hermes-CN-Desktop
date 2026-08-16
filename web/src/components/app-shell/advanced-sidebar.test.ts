import { describe, expect, it } from "vitest";
import { ADVANCED_ITEMS, getVisibleAdvancedItems } from "./advanced-sidebar";

describe("AdvancedSidebar – Android Remote regression", () => {
  it("hides desktop-only kernel and environment entries on Android Remote", () => {
    const visible = getVisibleAdvancedItems(true);
    const visiblePaths = visible.map((item) => item.path);
    expect(visiblePaths).not.toContain("/kernel");
    expect(visiblePaths).not.toContain("/env");
    expect(visible.length).toBe(ADVANCED_ITEMS.length - 2);
  });

  it("keeps /about visible on Android Remote (mobile build-info page)", () => {
    const visible = getVisibleAdvancedItems(true);
    expect(visible.map((item) => item.path)).toContain("/about");
  });

  it("keeps all entries on desktop shells", () => {
    expect(getVisibleAdvancedItems(false)).toBe(ADVANCED_ITEMS);
  });
});
