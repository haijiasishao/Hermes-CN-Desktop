import { describe, expect, it } from "vitest";
import { normalizeProbeResult } from "./connection-providers";

describe("normalizeProbeResult", () => {
  it("keeps only valid providers and applies defensive field defaults", () => {
    const result = normalizeProbeResult({
      reachable: true,
      authRequired: true,
      authProviders: [
        { name: "password", displayName: "Password", supportsPassword: true },
        { name: "oauth", displayName: "OAuth", supportsPassword: false },
        { name: "fallback-name" },
        { name: "null-display", displayName: null, supportsPassword: "true" },
        null,
        "not-an-object",
        { displayName: "missing-name", supportsPassword: true },
        { name: 42, displayName: "wrong-name-type" },
        { name: "   ", displayName: "blank-name" },
      ],
    });

    expect(result).toEqual({
      reachable: true,
      authRequired: true,
      authProviders: [
        { name: "password", displayName: "Password", supportsPassword: true },
        { name: "oauth", displayName: "OAuth", supportsPassword: false },
        { name: "fallback-name", displayName: "fallback-name", supportsPassword: false },
        { name: "null-display", displayName: "null-display", supportsPassword: false },
      ],
    });
  });

  it("treats null and non-object bridge responses as an unreachable empty result", () => {
    expect(normalizeProbeResult(null)).toEqual({
      reachable: false,
      authRequired: false,
      authProviders: [],
    });
    expect(normalizeProbeResult("unexpected")).toEqual({
      reachable: false,
      authRequired: false,
      authProviders: [],
    });
  });

  it("does not let missing provider arrays or malformed fields escape", () => {
    expect(normalizeProbeResult({ reachable: true, authRequired: true }).authProviders).toEqual([]);
    expect(normalizeProbeResult({ reachable: true, authRequired: true, authProviders: {} }).authProviders)
      .toEqual([]);
  });
});
