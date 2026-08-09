import { describe, expect, it } from "vitest";
import { ADVANCED_ITEMS, getVisibleAdvancedItems } from "./advanced-sidebar";

describe("AdvancedSidebar – Android Remote regression", () => {
  it("hides desktop-only kernel, environment, and about entries on Android Remote", () => {
    const visible = getVisibleAdvancedItems(true);
    const visiblePaths = visible.map((item) => item.path);
    expect(visiblePaths).not.toContain("/kernel");
    expect(visiblePaths).not.toContain("/env");
    expect(visiblePaths).not.toContain("/about");
    expect(visible.length).toBe(ADVANCED_ITEMS.length - 3);
  });

  it("keeps all entries on desktop shells", () => {
    expect(getVisibleAdvancedItems(false)).toBe(ADVANCED_ITEMS);
  });
});
