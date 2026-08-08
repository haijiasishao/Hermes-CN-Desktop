import { describe, expect, it } from "vitest";
import { ADVANCED_ITEMS, getVisibleAdvancedItems } from "./advanced-sidebar";

describe("AdvancedSidebar – Android Remote regression", () => {
  it("hides desktop-only kernel and environment entries on Android Remote", () => {
    const visible = getVisibleAdvancedItems(true);
    expect(visible.map((item) => item.path)).not.toEqual(expect.arrayContaining(["/kernel", "/env"]));
    expect(visible.length).toBe(ADVANCED_ITEMS.length - 2);
  });

  it("keeps kernel and environment entries on desktop shells", () => {
    expect(getVisibleAdvancedItems(false)).toBe(ADVANCED_ITEMS);
  });
});
