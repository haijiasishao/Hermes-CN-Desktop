export const ANDROID_REMOTE_HIDDEN_PROVIDER_IDS = new Set([
  "cp.compshare.cn",
  "modelverse",
]);

/**
 * Provider IDs that must not be exposed in the Android Remote-only settings UI.
 * Keep aliases here because old config files may use a legacy provider id.
 */
export function isAndroidRemoteHiddenProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return (
    ANDROID_REMOTE_HIDDEN_PROVIDER_IDS.has(normalized) ||
    normalized.includes("compshare") ||
    normalized.includes("modelverse") ||
    normalized.includes("youyun")
  );
}

export function filterAndroidRemoteProviders<T extends { id: string }>(
  providers: readonly T[],
  androidRemoteOnly: boolean,
): T[] {
  return androidRemoteOnly
    ? providers.filter((provider) => !isAndroidRemoteHiddenProviderId(provider.id))
    : [...providers];
}

export function isAndroidRemoteHiddenEnvKey(key: string): boolean {
  return key.trim().toUpperCase().startsWith("COMPSHARE_");
}
