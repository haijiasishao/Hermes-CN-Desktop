import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Database, RefreshCw } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import {
  VISIBLE_MEMORY_PROVIDERS,
  useMemoryProviderConfig,
  useMemoryProviders,
  useMemoryProviderStatus,
  useSaveMemoryProviderConfig,
  useSetMemoryProvider,
  useSetupMemoryProvider,
  type VisibleMemoryProvider,
} from "@/hooks/use-memory";
import { MemoryProviderConfig } from "./memory-provider-config";
import { MemoryProviderStatus } from "./memory-provider-status";
import {
  formatCheckedAt,
  hasAnyFieldSet,
  MEMORY_BACKEND_META,
  memoryBackendState,
} from "./memory-backend-utils";
import { dashboardAuthErrorMessage, isDashboardAuthError } from "@/lib/dashboard-error";
import s from "./memory-backends.module.css";
function isDashboardStatusNotFound(error: unknown): boolean {
  if (error instanceof Error && /HTTP\s+404/.test(error.message)) return true;
  if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) return true;
  return false;
}


function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MemoryBackendsPanelProps {
  view: "config" | VisibleMemoryProvider;
}

export function MemoryBackendsPanel({ view }: MemoryBackendsPanelProps) {
  const isConfigView = view === "config";
  const selected: VisibleMemoryProvider = view === "config" ? "openviking" : view;
  const providersQuery = useMemoryProviders({ enabled: true });
  const openVikingStatus = useMemoryProviderStatus("openviking", isConfigView || selected === "openviking");
  const hindsightStatus = useMemoryProviderStatus("hindsight", isConfigView || selected === "hindsight");
  const [actionError, setActionError] = useState("");
  const configQuery = useMemoryProviderConfig(selected, !isConfigView);
  // Config view: read both providers' config to compute configFieldsSet
  const openVikingConfigQuery = useMemoryProviderConfig("openviking", isConfigView);
  const hindsightConfigQuery = useMemoryProviderConfig("hindsight", isConfigView);
  const saveConfig = useSaveMemoryProviderConfig();
  const setupProvider = useSetupMemoryProvider();
  const setProvider = useSetMemoryProvider();

  const statusQueries = useMemo(() => ({
    openviking: openVikingStatus,
    hindsight: hindsightStatus,
  }), [openVikingStatus, hindsightStatus]);
  const configQueries = useMemo(() => ({
    openviking: openVikingConfigQuery,
    hindsight: hindsightConfigQuery,
  }), [openVikingConfigQuery, hindsightConfigQuery]);
  const selectedStatusQuery = statusQueries[selected];
  const selectedStatus = selectedStatusQuery.data;
  const active = providersQuery.data?.active ?? "";

  const activeStatus = VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)
    ? statusQueries[active as VisibleMemoryProvider].data
    : undefined;
  const activeMeta = VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)
    ? MEMORY_BACKEND_META[active as VisibleMemoryProvider]
    : undefined;
  const dashboardAuthRequired = [
    providersQuery.error,
    openVikingStatus.error,
    hindsightStatus.error,
    configQuery.error,
    ...(isConfigView ? [openVikingConfigQuery.error, hindsightConfigQuery.error] : []),
  ].some(isDashboardAuthError);
  const activeProviderOption = providersQuery.data?.options?.find((o) => o.name === active);
  const activeStatusUnavailable = Boolean(
    active && isDashboardStatusNotFound(statusQueries[active as VisibleMemoryProvider]?.error) && !statusQueries[active as VisibleMemoryProvider]?.data,
  );
  // Non-404, non-auth status errors (500, network) — surface as failure state
  // instead of silently falling through to the misleading "未配置" label.
  const activeStatusError = Boolean(
    active && statusQueries[active as VisibleMemoryProvider]?.isError
    && !statusQueries[active as VisibleMemoryProvider]?.data
    && !activeStatusUnavailable
    && !isDashboardAuthError(statusQueries[active as VisibleMemoryProvider]?.error),
  );
  const activeConfigQuery = isConfigView && VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)
    ? configQueries[active as VisibleMemoryProvider]
    : undefined;
  const activeConfigFieldsSet = isConfigView && activeConfigQuery?.data !== undefined
    ? hasAnyFieldSet(activeConfigQuery.data)
    : undefined;
  const activeConfigLoadFailed = isConfigView ? Boolean(activeConfigQuery?.isError) : undefined;
  const overallState = memoryBackendState(activeStatus, dashboardAuthRequired, {
    statusUnavailable: activeStatusUnavailable,
    statusError: activeStatusError,
    providerActive: active === providersQuery.data?.active,
    providerConfigured: activeProviderOption?.configured,
    configFieldsSet: activeConfigFieldsSet,
    configLoadFailed: activeConfigLoadFailed,
  });

  const refreshAll = () => {
    void providersQuery.refetch();
    void openVikingStatus.refetch();
    void hindsightStatus.refetch();
    if (isConfigView) {
      void openVikingConfigQuery.refetch();
      void hindsightConfigQuery.refetch();
    }
  };

  const handleSave = async (values: Record<string, unknown>) => {
    setActionError("");
    try {
      await saveConfig.mutateAsync({ provider: selected, values });
      const selectedConfigQuery = isConfigView ? configQueries[selected] : configQuery;
      await Promise.all([selectedConfigQuery.refetch(), selectedStatusQuery.refetch(), providersQuery.refetch()]);
    } catch (error) {
      setActionError(message(error));
      throw error;
    }
  };

  const handleSetup = async () => {
    setActionError("");
    try {
      await setupProvider.mutateAsync(selected);
      const selectedConfigQuery = isConfigView ? configQueries[selected] : configQuery;
      await Promise.all([selectedConfigQuery.refetch(), selectedStatusQuery.refetch(), providersQuery.refetch()]);
    } catch (error) {
      setActionError(message(error));
    }
  };

  const handleActivate = async () => {
    if (!selectedStatus?.healthy) return;
    setActionError("");
    try {
      await setProvider.mutateAsync(selected);
      await Promise.all([providersQuery.refetch(), selectedStatusQuery.refetch()]);
    } catch (error) {
      setActionError(message(error));
    }
  };

  if (isConfigView) {
    return (
      <section className={s.backendPanel} data-view="config">
        <header className={s.backendSummary}>
          <span className={s.summaryIcon}><Database size={16} /></span>
          <div>
            <small>当前后端</small>
            <strong>{activeMeta?.label ?? "未选择"}</strong>
            <span>{overallState.label}</span>
          </div>
          <div className={s.summaryCheck}>
            <em className={s.stateBadge} data-tone={overallState.tone}>{overallState.label}</em>
            <small>
              {activeStatus?.checked_at ? `最后检查 ${formatCheckedAt(activeStatus.checked_at)}` : "尚未检查"}
            </small>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw size={12} /> 刷新全部
          </Button>
        </header>

        <p className={s.backendIntro}>
          每个 Hermes 档案只能启用一个外置记忆后端。先保存并检测，确认在线可用后再设为当前；另一个后端的配置不会被删除。
        </p>

        {dashboardAuthRequired && (
          <div className={s.inlineError} role="alert">
            {dashboardAuthErrorMessage("远程 Dashboard")} OpenViking 当前状态和配置不会被误判为"未配置"。{" "}
            <Link to="/connection">打开连接设置</Link>
          </div>
        )}
        {providersQuery.isError && !dashboardAuthRequired && <div className={s.inlineError}>无法读取记忆后端列表：{message(providersQuery.error)}</div>}

        <div className={s.backendSwitcher}>
          {VISIBLE_MEMORY_PROVIDERS.map((provider) => {
            const meta = MEMORY_BACKEND_META[provider];
            const status = statusQueries[provider].data;
            const providerStatusUnavailable = Boolean(
              isDashboardStatusNotFound(statusQueries[provider].error) && !statusQueries[provider].data,
            );
            const providerStatusError = Boolean(
              statusQueries[provider].isError
              && !statusQueries[provider].data
              && !providerStatusUnavailable
              && !isDashboardAuthError(statusQueries[provider].error),
            );
            const providerOption = providersQuery.data?.options?.find((o) => o.name === provider);
            const providerCfgQuery = isConfigView
              ? configQueries[provider]
              : provider === selected
                ? configQuery
                : undefined;
            const providerConfigFieldsSet = providerCfgQuery?.data !== undefined
              ? hasAnyFieldSet(providerCfgQuery.data)
              : undefined;
            const providerConfigLoadFailed = Boolean(providerCfgQuery?.isError);
            const state = memoryBackendState(status, dashboardAuthRequired, {
              statusUnavailable: providerStatusUnavailable,
              statusError: providerStatusError,
              providerActive: provider === providersQuery.data?.active,
              providerConfigured: providerOption?.configured,
              configFieldsSet: providerConfigFieldsSet,
              configLoadFailed: providerConfigLoadFailed,
            });
            return (
              <Link
                key={provider}
                to={`/${provider}`}
                className={s.backendLink}
                data-active={status?.active && status?.healthy ? "true" : undefined}
              >
                <span className={s.backendCardHead}>
                  <strong>{meta.label}</strong>
                  <em className={s.stateBadge} data-tone={state.tone}>{state.label}</em>
                </span>
                <span>{meta.description}</span>
                <small>
                  {status?.version ? `v${status.version}` : statusQueries[provider].isFetching ? "检测中…" : "尚未返回版本"}
                  {status?.active && status?.healthy && <b><Check size={12} /> 当前</b>}
                  {status?.active && !status?.healthy && <b className={s.activeWarning}>当前选择（异常）</b>}
                </small>
              </Link>
            );
          })}
        </div>
      </section>
    );
  }

  const isActiveAndHealthy = Boolean(selectedStatus?.active && selectedStatus?.healthy);
  const isActiveButUnhealthy = Boolean(selectedStatus?.active && !selectedStatus?.healthy);
  const selectedStatusUnavailable = Boolean(
    isDashboardStatusNotFound(selectedStatusQuery.error) && !selectedStatus,
  );
  const selectedStatusError = Boolean(
    selectedStatusQuery.isError
    && !selectedStatus
    && !selectedStatusUnavailable
    && !isDashboardAuthError(selectedStatusQuery.error),
  );

  return (
    <section className={s.backendPanel} data-view="provider">
      {dashboardAuthRequired && (
        <div className={s.inlineError} role="alert">
          {dashboardAuthErrorMessage("远程 Dashboard")} 配置和运行状态将在登录后重新读取。{" "}
          <Link to="/connection">打开连接设置</Link>
        </div>
      )}
      {providersQuery.isError && !dashboardAuthRequired && <div className={s.inlineError}>无法读取记忆后端列表：{message(providersQuery.error)}</div>}
      <div className={s.backendDetail} data-standalone="true">
        <div className={s.detailHeader}>
          <div>
            <small>正在配置</small>
            <strong>{MEMORY_BACKEND_META[selected].label}</strong>
          </div>
          {isActiveAndHealthy ? (
            <span className={s.stateBadge} data-tone="active"><Check size={12} /> 当前启用</span>
          ) : isActiveButUnhealthy ? (
            <Button
              type="button"
              variant="solid"
              tone="neutral"
              size="sm"
              disabled
            >
              当前选择（异常）
            </Button>
          ) : (
            <Button
              type="button"
              variant="solid"
              tone="accent"
              size="sm"
              disabled={!selectedStatus?.healthy || setProvider.isPending}
              onClick={() => void handleActivate()}
            >
              设为当前
            </Button>
          )}
        </div>

        {!selectedStatus?.reachable && selectedStatus?.configured && (
          <div className={s.offlineHint}>{MEMORY_BACKEND_META[selected].offlineHint}</div>
        )}

        <MemoryProviderStatus
          provider={selected}
          status={selectedStatus}
          loading={selectedStatusQuery.isLoading}
          refreshing={selectedStatusQuery.isFetching}
          authRequired={dashboardAuthRequired}
          statusUnavailable={selectedStatusUnavailable}
          statusError={selectedStatusError}
          onRefresh={() => void selectedStatusQuery.refetch()}
        />

        <MemoryProviderConfig
          provider={selected}
          config={configQuery.data}
          loading={configQuery.isLoading}
          saving={saveConfig.isPending}
          setupPending={setupProvider.isPending}
          error={actionError || (dashboardAuthRequired ? dashboardAuthErrorMessage("远程 Dashboard") : configQuery.error ? message(configQuery.error) : undefined)}
          onSave={handleSave}
          onSetup={handleSetup}
        />
      </div>
    </section>
  );
}
