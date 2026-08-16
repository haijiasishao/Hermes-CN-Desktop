import type { AuthProviderInfo } from "@hermes/protocol";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAuthProviders(value: unknown): AuthProviderInfo[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate): AuthProviderInfo[] => {
    if (!isRecord(candidate) || typeof candidate.name !== "string") return [];
    const name = candidate.name.trim();
    if (!name) return [];

    const displayName =
      typeof candidate.displayName === "string" && candidate.displayName.trim()
        ? candidate.displayName.trim()
        : name;

    return [{
      name,
      displayName,
      supportsPassword: candidate.supportsPassword === true,
    }];
  });
}

export function normalizeProbeResult(value: unknown): {
  reachable: boolean;
  authRequired: boolean;
  authProviders: AuthProviderInfo[];
} {
  if (!isRecord(value)) {
    return { reachable: false, authRequired: false, authProviders: [] };
  }

  return {
    reachable: value.reachable === true,
    authRequired: value.authRequired === true,
    authProviders: normalizeAuthProviders(value.authProviders),
  };
}
