// Settings → 连接: Android only attaches to a remote Hermes Agent Dashboard.
// Token and OAuth/cookie authentication are both supported.
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe2,
  XCircle,
} from "lucide-react";
import type {
  AuthIdentity,
  AuthProviderInfo,
  ConnectionConfigView,
  ConnectionMode,
  TestConnectionResult,
} from "@hermes/protocol";
import { Alert, Button, Input, LoadingIndicator } from "@hermes/shared-ui";
import { notifyConnectionAuthRestored } from "@/lib/connection-auth-events";
import { SettingsHero } from "./settings-hero";
import s from "./settings.module.css";

interface SettingsSectionProps {
  showHeading?: boolean;
  externalOnly?: boolean;
  onApplied?: (mode: ConnectionMode) => Promise<void> | void;
}

type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";
type ConnectionMessage = { tone: "ok" | "error"; text: string; hint?: string };

const PROBE_DEBOUNCE_MS = 500;

function modeLabel(mode: ConnectionMode | undefined): string {
  return mode === "remote" ? "远程 Hermes Agent" : "远程 Hermes Agent（待连接）";
}

function testResultSummary(result: TestConnectionResult): ConnectionMessage {
  if (result.ok) {
    const version = result.version ? ` · Hermes ${result.version}` : "";
    return { tone: "ok", text: `连接正常（${result.baseUrl}${version}）` };
  }
  const detail = result.error ?? "连接失败";
  const parts = [
    `接口 ${result.httpOk ? "✓" : `✗${result.httpStatus ? ` (${result.httpStatus})` : ""}`}`,
    `实时连接 ${result.wsOk ? "✓" : "✗"}`,
  ];
  return { tone: "error", text: `${detail}　[${parts.join("，")}]` };
}

export function ConnectionSection({
  showHeading = true,
  externalOnly = false,
  onApplied,
}: SettingsSectionProps) {
  const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  const supported = Boolean(desktop?.getConnectionConfig);
  const browserCompanion = Boolean(window.__HERMES_RUNTIME__?.browserCompanion);

  const [config, setConfig] = useState<ConnectionConfigView | null>(null);
  const [loadError, setLoadError] = useState("");
  const mode: ConnectionMode = "remote";
  const [remoteUrl, setRemoteUrl] = useState("");
  // The saved token never round-trips; this holds only what the user types.
  const [tokenInput, setTokenInput] = useState("");
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const probeSeq = useRef(0);
  // OAuth gate state (populated when a remote probe reports auth_required).
  const [authProviders, setAuthProviders] = useState<AuthProviderInfo[]>([]);
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [pwUser, setPwUser] = useState("");
  const [pwPass, setPwPass] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [browserMessage, setBrowserMessage] = useState<ConnectionMessage | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  useEffect(() => {
    if (!desktop?.getConnectionConfig) return;
    desktop
      .getConnectionConfig()
      .then((view) => {
        setConfig(view);
        setRemoteUrl(view.remoteUrl);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop, externalOnly]);

  const envOverride = config?.envOverride ?? false;
  const busy = saving || applying;
  const disabled = !supported || envOverride || busy || (externalOnly && !config);
  const trimmedRemoteUrl = remoteUrl.trim();
  const effectiveMode = config?.effectiveMode ?? "remote";

  // Debounced as-you-type reachability probe for remote URLs, sequence-guarded
  // so a slow response for an old URL can't overwrite the current status.
  useEffect(() => {
    if (mode !== "remote" || envOverride || !/^https?:\/\//i.test(trimmedRemoteUrl)) {
      setProbeStatus("idle");
      return;
    }
    const seq = ++probeSeq.current;
    setProbeStatus("probing");
    const timer = window.setTimeout(() => {
      desktop
        ?.probeConnectionConfig?.(trimmedRemoteUrl)
        .then((result) => {
          if (seq !== probeSeq.current) return;
          if (!result.reachable) setProbeStatus("unreachable");
          else if (result.authRequired) {
            setProbeStatus("authRequired");
            setAuthProviders(result.authProviders ?? []);
          } else {
            setProbeStatus("reachable");
            setAuthProviders([]);
          }
        })
        .catch(() => {
          if (seq !== probeSeq.current) return;
          setProbeStatus("unreachable");
        });
    }, PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, trimmedRemoteUrl, envOverride]);

  // A remote that enforces a login gate uses OAuth/cookie auth, not a token.
  const gated = mode === "remote" && probeStatus === "authRequired";

  // When the URL changes, drop any shown identity (it belonged to the old
  // gateway); if the new gateway is gated and we have a saved session, restore.
  useEffect(() => {
    setIdentity(null);
    if (mode !== "remote" || !gated || !/^https?:\/\//i.test(trimmedRemoteUrl)) return;
    let cancelled = false;
    desktop
      ?.connectionAuthMe?.(trimmedRemoteUrl)
      .then((r) => {
        if (!cancelled && r.ok && r.identity) setIdentity(r.identity);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, trimmedRemoteUrl]);

  const handleOauthLogin = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionOauthLogin(trimmedRemoteUrl);
      if (r.ok) {
        setIdentity(r.identity ?? null);
        if (desktop.applyConnectionConfig) {
          const applied = await desktop.applyConnectionConfig({
            mode: "remote",
            remoteUrl: trimmedRemoteUrl,
            remoteAuthMode: "oauth",
          });
          if (!applied.ok) {
            setMessage({ tone: "error", text: applied.error ?? "OAuth 连接应用失败" });
            return;
          }
        }
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handlePasswordLogin = async (provider: string): Promise<void> => {
    if (!desktop?.connectionPasswordLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionPasswordLogin({
        remoteUrl: trimmedRemoteUrl,
        provider,
        username: pwUser,
        password: pwPass,
      });
      if (r.ok) {
        setIdentity(r.identity ?? null);
        setPwPass("");
        if (desktop.applyConnectionConfig) {
          const applied = await desktop.applyConnectionConfig({
            mode: "remote",
            remoteUrl: trimmedRemoteUrl,
            remoteAuthMode: "oauth",
          });
          if (!applied.ok) {
            setMessage({ tone: "error", text: applied.error ?? "OAuth 连接应用失败" });
            return;
          }
        }
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogout) return;
    try {
      await desktop.connectionOauthLogout(trimmedRemoteUrl);
    } catch {}
    setIdentity(null);
    setMessage({ tone: "ok", text: "已注销" });
  };

  const remoteReady = gated
    ? Boolean(identity) // oauth: must be logged in
    : Boolean(trimmedRemoteUrl && (tokenInput.trim() || config?.remoteTokenSet));
  const canSubmit = remoteReady;
  const identityLabel = identity
    ? identity.displayName || identity.email || identity.userId || "已登录"
    : null;

  const handleTest = async () => {
    if (!desktop?.testConnectionConfig) return;
    setMessage(null);
    setTesting(true);
    try {
      const result = await desktop.testConnectionConfig({
        mode: "remote",
        remoteUrl: trimmedRemoteUrl,
        remoteToken: !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: gated ? "oauth" : "token",
      });
      setMessage(testResultSummary(result));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (apply: boolean) => {
    if (!canSubmit) {
      setMessage({
        tone: "error",
        text: gated ? "请先完成远程登录" : "请先填写远程地址和会话令牌",
      });
      return;
    }
    setMessage(null);
    const setBusy = apply ? setApplying : setSaving;
    setBusy(true);
    try {
      const payload = {
        mode: "remote" as const,
        remoteUrl: trimmedRemoteUrl,
        remoteToken: !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: gated ? ("oauth" as const) : ("token" as const),
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
          setMessage({ tone: "ok", text: "已切换，正在重新加载界面…" });
          if (onApplied) {
            await onApplied(mode);
            return;
          }
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        setMessage({ tone: "error", text: result.error ?? "切换失败" });
      } else {
        const view = await desktop!.saveConnectionConfig!(payload);
        setConfig(view);
        setTokenInput("");
        setMessage({ tone: "ok", text: "已保存，下次启动应用时生效" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleOpenBrowser = async () => {
    if (!desktop?.openBrowserCompanion) return;
    setOpeningBrowser(true);
    setBrowserMessage(null);
    try {
      await desktop.openBrowserCompanion();
      setBrowserMessage({ tone: "ok", text: "已在系统浏览器中打开社区桌面版" });
    } catch (error) {
      setBrowserMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpeningBrowser(false);
    }
  };

  if (!supported) {
    if (browserCompanion) {
      return (
        <div>
          {showHeading && <h2 className={s.heading}>连接</h2>}
          <SettingsHero
            ok
            icon={<Globe2 size={24} />}
            eyebrow="浏览器伴生模式"
            title="已通过社区桌面版连接"
            description="当前浏览器的 REST 与实时网关通信均由桌面端安全转发；连接目标由桌面端统一管理。需要切换内核时，请回到桌面端的连接页面操作。"
            badge={<span className={s.statusBadge} data-on="true">已连接</span>}
          />
        </div>
      );
    }
    return (
      <div>
        {showHeading && <h2 className={s.heading}>连接</h2>}
        <div className={s.rowSub}>连接配置仅在桌面端可用。</div>
      </div>
    );
  }

  const tokenPlaceholder = config?.remoteTokenSet
    ? `已保存（${config.remoteTokenPreview ?? "set"}），留空保持不变`
    : "粘贴远程后端的会话令牌";
  const connectionLoaded = Boolean(config) && !loadError;
  const connectionTitle = !connectionLoaded
    ? "正在读取连接状态"
    : envOverride
      ? "连接由环境变量覆盖"
      : `当前连接目标：${modeLabel(effectiveMode)}`;
  const connectionDescription = envOverride
    ? `当前会话由环境变量强制连接到远程端（${config?.remoteUrl ?? "远程地址"}），需取消环境变量后才能在此修改。`
    : "Android 版不运行本地 Hermes 内核，仅通过 Dashboard/API 远程连接已部署的 Hermes Agent。";
  const connectionBadge = !connectionLoaded ? "读取中" : envOverride ? "环境变量" : modeLabel(effectiveMode);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>连接</h2>}

      {!externalOnly && (
        <SettingsHero
          ok={connectionLoaded}
          icon={<Globe2 size={24} />}
          eyebrow="Hermes Agent 连接"
          title={connectionTitle}
          description={connectionDescription}
          badge={<span className={s.statusBadge} data-on={connectionLoaded}>{connectionBadge}</span>}
        />
      )}

      {!externalOnly && desktop?.openBrowserCompanion && (
        <div className={s.connBrowserCompanion}>
          <div className={s.connBrowserCompanionCopy}>
            <div className={s.connBrowserCompanionTitle}>在浏览器中使用社区桌面版</div>
            <div className={s.rowSub}>
              由当前桌面端安全转发内核连接，无需在浏览器里复制会话令牌。
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleOpenBrowser()}
            loading={openingBrowser}
            leadingIcon={<ExternalLink size={12} />}
          >
            在浏览器中打开社区桌面版
          </Button>
        </div>
      )}

      {browserMessage && (
        <Alert className={s.connResult} tone={browserMessage.tone} size="sm">
          {browserMessage.text}
        </Alert>
      )}

      {loadError && <div className={s.connResult} data-tone="error">{loadError}</div>}

      {envOverride && (
        <div className={s.connEnvWarn}>
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>当前会话由环境变量强制为远程模式（{config?.remoteUrl}）。</div>
            <div style={{ marginTop: 4 }}>
              取消设置 <code>HERMES_DESKTOP_REMOTE_URL</code> 和 <code>HERMES_DESKTOP_REMOTE_TOKEN</code>{" "}
              后才能在此修改连接。
            </div>
          </div>
        </div>
      )}

      <>
          <div className={`${s.row} ${s.connRow}`}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>远程地址</div>
              <div className={s.rowSub}>
                远程 Hermes 后端的地址，支持路径前缀（如 https://gateway.example.com/hermes）。
              </div>
              {probeStatus !== "idle" && (
                <div
                  className={s.connProbe}
                  data-tone={probeStatus === "reachable" ? "ok" : probeStatus === "probing" ? undefined : "error"}
                  aria-live="polite"
                >
                  {probeStatus === "probing" && <LoadingIndicator size="xs" />}
                  {probeStatus === "reachable" && <CheckCircle2 size={12} />}
                  {(probeStatus === "unreachable" || probeStatus === "authRequired") && <XCircle size={12} />}
                  {probeStatus === "probing" && "正在检测连接方式…"}
                  {probeStatus === "reachable" && "后端可达"}
                  {probeStatus === "unreachable" && "暂时无法连接，检查地址与网络后会自动重试"}
                  {probeStatus === "authRequired" && "该后端启用了登录门，请在下方登录后再连接"}
                </div>
              )}
            </div>
            <div className={s.rowRight}>
              <Input
                mono
                className={s.connControl}
                value={remoteUrl}
                placeholder="https://gateway.example.com/hermes"
                disabled={disabled}
                onChange={(e) => setRemoteUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          {!gated && (
            <div className={`${s.row} ${s.connRow}`}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>会话令牌</div>
                <div className={s.rowSub}>
                  连接远程后端时使用的会话令牌，仅保存在本机，留空保持不变。
                </div>
              </div>
              <div className={s.rowRight}>
                <Input
                  type="password"
                  className={s.connControl}
                  value={tokenInput}
                  placeholder={tokenPlaceholder}
                  disabled={disabled}
                  onChange={(e) => setTokenInput(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          {gated && (
            <div className={`${s.row} ${s.connRow}`}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>登录</div>
                <div className={s.rowSub}>
                  {identityLabel
                    ? `已登录：${identityLabel}`
                    : "该网关需要登录后才能连接。选择下方登录方式完成登录。"}
                </div>
              </div>
              <div className={`${s.rowRight} ${s.connAuthControls}`}>
                {identityLabel ? (
                  <Button type="button" variant="outline" onClick={() => void handleLogout()} disabled={disabled}>
                    注销
                  </Button>
                ) : (
                  <>
                    {authProviders
                      .filter((p) => !p.supportsPassword)
                      .map((p) => (
                        <Button
                          key={p.name}
                          type="button"
                          variant="solid"
                          tone="accent"
                          onClick={() => void handleOauthLogin()}
                          disabled={disabled}
                          loading={loggingIn}
                        >
                          使用 {p.displayName} 登录
                        </Button>
                      ))}
                    {authProviders
                      .filter((p) => p.supportsPassword)
                      .map((p) => (
                        <div key={p.name} className={s.connPasswordControls}>
                          <Input
                            className={s.connControl}
                            value={pwUser}
                            placeholder={`${p.displayName} 用户名`}
                            disabled={disabled || loggingIn}
                            onChange={(e) => setPwUser(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Input
                            type="password"
                            className={s.connControl}
                            value={pwPass}
                            placeholder="密码"
                            disabled={disabled || loggingIn}
                            onChange={(e) => setPwPass(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="solid"
                            tone="accent"
                            onClick={() => void handlePasswordLogin(p.name)}
                            disabled={disabled || !pwUser || !pwPass}
                            loading={loggingIn}
                          >
                            登录
                          </Button>
                        </div>
                      ))}
                    {authProviders.length === 0 && (
                      <div className={s.rowSub}>网关未注册任何登录方式，请检查网关配置。</div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
      </>

      <div className={s.connFooter}>
        <Button
          type="button"
          className={s.connFooterSpacer}
          variant="outline"
          onClick={() => void handleTest()}
          disabled={disabled || !trimmedRemoteUrl}
          loading={testing}
          leadingIcon={<Globe2 size={12} />}
        >
          测试连接
        </Button>
        {!externalOnly && (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { window.location.hash = "#/guide"; }}
            >
              重新运行使用引导
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void submit(false)}
              disabled={disabled || !canSubmit}
              aria-busy={saving}
            >
              仅保存（下次启动生效）
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="solid"
          tone="accent"
          onClick={() => void submit(true)}
          disabled={disabled || !canSubmit}
          loading={applying}
        >
          {externalOnly ? "连接并进入 Hermes" : "保存并连接远程"}
        </Button>
      </div>

      {message && (
        <Alert className={s.connResult} tone={message.tone} size="sm">
          <div>{message.text}</div>
          {message.hint && <div className={s.connResultHint}>{message.hint}</div>}
        </Alert>
      )}
    </div>
  );
}
