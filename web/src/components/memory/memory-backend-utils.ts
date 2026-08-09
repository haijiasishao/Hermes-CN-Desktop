import type {
  MemoryProviderRuntimeStatusResponse,
  MemoryProviderConfigField,
  MemoryProviderConfigResponse,
} from "@hermes/protocol";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";

export const MEMORY_BACKEND_META: Record<VisibleMemoryProvider, {
  label: string;
  description: string;
  offlineHint: string;
}> = {
  openviking: {
    label: "OpenViking",
    description: "本地或远程上下文数据库，提供分层召回、记忆提取与可观测组件。",
    offlineHint: "请确认 OpenViking 服务已在 Endpoint 启动。Hermes 只连接和监控，不会代为启停进程。",
  },
  hindsight: {
    label: "Hindsight",
    description: "基于事实、文档、观察与知识图谱的长期记忆后端。",
    offlineHint: "请确认 Hindsight API 已启动并可从本机访问。Hermes 不接管 Hindsight 服务进程。",
  },
};

const ADVANCED_FIELDS: Record<VisibleMemoryProvider, Set<string>> = {
  openviking: new Set([
    "recall_limit",
    "recall_score_threshold",
    "recall_max_injected_chars",
    "recall_timeout_seconds",
    "recall_request_timeout_seconds",
    "recall_full_read_limit",
    "recall_prefer_abstract",
    "recall_resources",
    "use_ovcli_config",
    "ovcli_config_path",
  ]),
  hindsight: new Set([
    "bank_id_template",
    "bank_mission",
    "bank_retain_mission",
    "recall_budget",
    "memory_mode",
    "recall_prefetch_method",
    "retain_tags",
    "observation_scopes",
    "retain_source",
    "retain_user_prefix",
    "retain_assistant_prefix",
    "recall_tags",
    "recall_tags_match",
    "recall_types",
    "auto_recall",
    "auto_retain",
    "retain_every_n_turns",
    "retain_async",
    "retain_context",
    "recall_max_tokens",
    "recall_max_input_chars",
    "recall_prompt_preamble",
    "timeout",
    "idle_timeout",
    "port_health_grace_timeout",
    "llm_provider",
    "llm_base_url",
    "llm_api_key",
    "llm_model",
  ]),
};

export function isAdvancedMemoryField(provider: VisibleMemoryProvider, key: string): boolean {
  return ADVANCED_FIELDS[provider].has(key);
}

export function isMemoryFieldVisible(
  field: MemoryProviderConfigField,
  values: Record<string, unknown>,
): boolean {
  if (!field.when) return true;
  return Object.entries(field.when).every(([key, expected]) => String(values[key] ?? "") === String(expected));
}

export function hasAnyFieldSet(config?: MemoryProviderConfigResponse): boolean {
  return (config?.fields ?? []).some(f => f.is_set);
}

export function memoryBackendState(
  status?: MemoryProviderRuntimeStatusResponse,
  authRequired = false,
  opts?: {
    statusUnavailable?: boolean;    // 404
    statusError?: boolean;          // 500/network
    providerActive?: boolean;       // from providersQuery.data?.active
    providerConfigured?: boolean;   // from provider list metadata
    configFieldsSet?: boolean;      // true if config loaded AND at least one field has is_set=true
    configLoadFailed?: boolean;     // true if config request failed
  },
): {
  label: "未配置" | "需登录" | "已保存但离线" | "在线可用" | "当前启用" | "运行异常" | "服务端记录的当前选择（待核验）" | "未配置（状态接口不可用）" | "配置已保存（状态接口不可用）" | "待核验（状态接口不可用）" | "配置待核验（状态接口不可用）" | "当前选择（状态读取失败）" | "未配置（状态读取失败）" | "配置已保存（状态读取失败）" | "状态读取失败（待核验）" | "配置待核验（状态读取失败）" | "已保存但待验证" | "配置待核验";
  tone: "muted" | "warn" | "ok" | "active" | "error";
} {
  // 1. authRequired
  if (authRequired) return { label: "需登录", tone: "warn" };

  // 2-4. Status exists and configured: healthy path
  if (status?.configured) {
    if (status.reachable && status.healthy) {
      // 2a. active → 当前启用
      if (status.active) return { label: "当前启用", tone: "active" };
      // 2b. !active → 在线可用
      return { label: "在线可用", tone: "ok" };
    }
    // 3. configured + reachable + !healthy → 运行异常
    if (status.reachable && !status.healthy) return { label: "运行异常", tone: "error" };
    // 4. configured + !reachable → 已保存但离线
    if (!status.reachable) return { label: "已保存但离线", tone: "warn" };
  }

  // 5. statusUnavailable (404)
  if (opts?.statusUnavailable) {
    if (opts.providerActive) return { label: "服务端记录的当前选择（待核验）", tone: "warn" };
    if (opts.configFieldsSet === true) return { label: "配置已保存（状态接口不可用）", tone: "warn" };
    if (opts.configFieldsSet === false) return { label: "未配置（状态接口不可用）", tone: "muted" };
    if (opts.configLoadFailed) return { label: "配置待核验（状态接口不可用）", tone: "warn" };
    return { label: "待核验（状态接口不可用）", tone: "warn" };
  }

  // 6. statusError (500/network)
  if (opts?.statusError) {
    if (opts.providerActive) return { label: "当前选择（状态读取失败）", tone: "error" };
    if (opts.configFieldsSet === true) return { label: "配置已保存（状态读取失败）", tone: "error" };
    if (opts.configFieldsSet === false) return { label: "未配置（状态读取失败）", tone: "muted" };
    if (opts.configLoadFailed) return { label: "配置待核验（状态读取失败）", tone: "error" };
    return { label: "状态读取失败（待核验）", tone: "error" };
  }

  // 7. !status?.configured (no status or status says not configured)
  if (opts?.configFieldsSet) return { label: "已保存但待验证", tone: "warn" };
  if (opts?.configLoadFailed) return { label: "配置待核验", tone: "warn" };
  return { label: "未配置", tone: "muted" };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function numericValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCheckedAt(value?: string): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function humanizeKey(key: string): string {
  const labels: Record<string, string> = {
    endpoint: "Endpoint",
    api_key: "API Key",
    account: "Account",
    user: "User",
    agent: "Agent",
    mode: "Mode",
    api_url: "API URL",
    bank_id: "Bank ID",
    dashboard_url: "Dashboard URL",
    recall_budget: "召回预算",
    bank_mission: "Bank Mission",
    bank_retain_mission: "Retain Mission",
  };
  return labels[key] ?? key.replaceAll("_", " ");
}

export function compactHealthDetail(value: unknown, healthy: boolean): string {
  if (typeof value !== "string" || !value.trim()) return healthy ? "正常" : "异常";
  const detail = value.trim();
  if (detail.length > 48 || detail.includes("\n") || detail.includes("+---")) {
    return healthy ? "正常" : "异常";
  }
  return detail;
}
