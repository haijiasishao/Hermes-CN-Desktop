import { describe, expect, it } from "vitest";
import { shouldShowOfflineAbout } from "./offline-shell-policy";

describe("offline shell Android policy", () => {
  it("removes About from Android Remote while preserving desktop", () => {
    expect(shouldShowOfflineAbout(true)).toBe(false);
    expect(shouldShowOfflineAbout(false)).toBe(true);
  });
});
