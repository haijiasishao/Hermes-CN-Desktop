export const ANDROID_REMOTE_HIDDEN_PROVIDER_IDS = new Set([
  "cp.compshare.cn",
  "modelverse",
]);

const REMOVED_PROVIDER_ID_ALIASES = new Set([
  "alibaba",
  "alibaba-coding-cn",
  "dashscope",
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

export function isRemovedProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return REMOVED_PROVIDER_ID_ALIASES.has(normalized) ||
    normalized.includes("alibaba") ||
    normalized.includes("dashscope");
}

export function filterRemovedProviders<T extends { id: string }>(providers: readonly T[]): T[] {
  return providers.filter((provider) => !isRemovedProviderId(provider.id));
}

/** Alibaba/DashScope credentials are removed from all configuration UIs. */
export function isRemovedProviderEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  return upper.startsWith("DASHSCOPE_") ||
    upper.startsWith("ALIBABA_") ||
    upper.startsWith("HERMES_QWEN_");
}

export function isAndroidRemoteHiddenEnvKey(key: string): boolean {
  return key.trim().toUpperCase().startsWith("COMPSHARE_");
}
