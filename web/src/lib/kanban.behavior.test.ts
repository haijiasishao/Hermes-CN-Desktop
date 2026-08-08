import { describe, expect, it, vi, afterEach } from "vitest";
import { formatRelativeTime, normalizePriority } from "./kanban";

describe("formatRelativeTime boundary cases", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 刚刚 for timestamps less than 60 seconds ago", () => {
    // 45 seconds ago
    vi.spyOn(Date, "now").mockReturnValue(1700000045000);
    expect(formatRelativeTime(1700000000)).toBe("刚刚");
  });

  it("returns 1 分钟前 at exactly 60 seconds boundary", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000060000);
    expect(formatRelativeTime(1700000000)).toBe("1 分钟前");
  });

  it("returns X 分钟前 for timestamps less than 1 hour ago", () => {
    // 30 minutes = 1800 seconds
    vi.spyOn(Date, "now").mockReturnValue(1700001800000);
    expect(formatRelativeTime(1700000000)).toBe("30 分钟前");
  });

  it("returns X 小时前 for timestamps less than 1 day ago", () => {
    // 10 hours = 36000 seconds
    vi.spyOn(Date, "now").mockReturnValue(1700036000000);
    expect(formatRelativeTime(1700000000)).toBe("10 小时前");
  });

  it("returns X 天前 for timestamps 1 or more days ago", () => {
    // 10 days
    vi.spyOn(Date, "now").mockReturnValue(1700864000000);
    expect(formatRelativeTime(1700000000)).toBe("10 天前");
  });

  it("returns X 个月前 for timestamps 30+ days ago", () => {
    // 60 days
    vi.spyOn(Date, "now").mockReturnValue(1700000000000 + 60 * 86400000);
    expect(formatRelativeTime(1700000000)).toBe("2 个月前");
  });

  it("handles null/undefined/empty gracefully", () => {
    expect(formatRelativeTime(null)).toBe("");
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime("")).toBe("");
  });

  it("handles ISO string timestamps", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000045000);
    expect(formatRelativeTime("2023-11-14T22:13:20.000Z")).toBeTruthy();
  });

  it("handles millisecond timestamps (> 1e12, no extra multiply)", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000045000);
    expect(formatRelativeTime(1700000000000)).toBe("刚刚");
  });

  it("handles millisecond timestamps at boundary (60s)", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000060000);
    expect(formatRelativeTime(1700000000000)).toBe("1 分钟前");
  });
});

describe("normalizePriority", () => {
  it("maps 0 to normal", () => {
    expect(normalizePriority(0)).toBe("normal");
  });

  it("maps 1 to critical", () => {
    expect(normalizePriority(1)).toBe("critical");
  });

  it("maps 2 to high", () => {
    expect(normalizePriority(2)).toBe("high");
  });

  it("passes through string values unchanged", () => {
    expect(normalizePriority("medium")).toBe("medium");
    expect(normalizePriority("high")).toBe("high");
    expect(normalizePriority("normal")).toBe("normal");
  });

  it("returns normal for unknown types", () => {
    expect(normalizePriority(undefined)).toBe("normal");
    expect(normalizePriority(null)).toBe("normal");
  });

  it("converts numeric values ≥ 3 to string", () => {
    expect(normalizePriority(3)).toBe("3");
    expect(normalizePriority(5)).toBe("5");
  });
});
