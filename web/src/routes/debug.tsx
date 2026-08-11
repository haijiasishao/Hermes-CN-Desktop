import { useMemo, useState } from "react";
import { Bug, FileArchive, FolderOpen } from "lucide-react";
import { LoadingIndicator } from "@hermes/shared-ui";
import { debugBus } from "@/lib/debug-bus";
import { BUILD_COMMIT, BUILD_DATE, DESKTOP_VERSION } from "@/lib/build-info";
import { runtime } from "@/lib/runtime";
import { DebugSection } from "./settings-debug-section";
import { SectionShell } from "./section-shell";
import s from "./settings.module.css";

type ExportState =
  | { tone: "normal" | "error"; message: string }
  | null;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function buildRendererDiagnostics(): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    location: typeof window !== "undefined" ? window.location.href : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    platform: runtime.platform,
    hermesRuntime: typeof window !== "undefined" ? window.__HERMES_RUNTIME__ ?? null : null,
    bridge: typeof window !== "undefined" ? {
      windowType: window.hermesDesktop?.windowType ?? null,
      hasExportDebugBundle: Boolean(window.hermesDesktop?.exportDebugBundle),
      hasSaveDebugBundle: Boolean(window.hermesDesktop?.saveDebugBundle),
      hasRequest: Boolean(window.hermesDesktop?.request),
      hasRuntimeInfo: Boolean(window.hermesDesktop?.getRuntimeInfo),
    } : null,
    build: {
      version: DESKTOP_VERSION,
      commit: BUILD_COMMIT,
      date: BUILD_DATE,
    },
    viewport: typeof window !== "undefined" ? {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    } : null,
    debugEntries: debugBus.snapshot().length,
  };
}

export function DebugRoute() {
  const [exporting, setExporting] = useState(false);
  const [exportState, setExportState] = useState<ExportState>(null);
  const canExport = typeof window !== "undefined" && Boolean(window.hermesDesktop?.exportDebugBundle);
  const androidRemoteOnly = runtime.androidRemoteOnly;

  const exportSubText = useMemo(() => {
    if (canExport && androidRemoteOnly) {
      return "会生成已脱敏的 debug ZIP，并打开 Android 系统文件保存窗口。请选择 Downloads 或其他可访问位置保存，应用缓存路径不会作为用户文件位置展示。";
    }
    if (canExport) {
      return "会打包前端 Debug 快照、桌面 runtime 诊断、已脱敏配置摘要，以及 HERMES_HOME 和 gateway runtime 下的日志文件。导出后会自动打开 zip 所在文件夹。";
    }
    return "当前不是 Tauri 桌面环境，无法直接生成本地 debug zip。";
  }, [androidRemoteOnly, canExport]);

  const handleExport = async () => {
    if (!window.hermesDesktop?.exportDebugBundle) return;
    setExporting(true);
    setExportState(null);
    try {
      const result = await window.hermesDesktop.exportDebugBundle({
        frontendDebug: debugBus.snapshot(),
        rendererDiagnostics: buildRendererDiagnostics(),
      });
      if (androidRemoteOnly) {
        const saveDebugBundle = window.hermesDesktop.saveDebugBundle;
        if (!saveDebugBundle) {
          throw new Error("当前 Android 包未提供系统文件保存能力");
        }
        const saved = await saveDebugBundle({
          sourcePath: result.zipPath,
          fileName: result.zipPath.split(/[\\/]/).pop() || "hermes-debug.zip",
        });
        if (saved.canceled) {
          setExportState({ tone: "normal", message: "已取消保存，本次 debug 包未导出到系统文件位置。" });
          return;
        }
        if (!saved.ok) {
          throw new Error("Android 系统文件位置写入失败");
        }
        const warningText = result.warnings.length > 0 ? `，另有 ${result.warnings.length} 条提示` : "";
        setExportState({
          tone: "normal",
          message: `已保存 ${formatBytes(saved.bytes ?? result.sizeBytes)} 的 debug 包，共 ${result.includedFiles} 个文件${warningText}。请在刚才选择的系统文件位置查找。`,
        });
        return;
      }
      const warningText = result.warnings.length > 0 ? `，另有 ${result.warnings.length} 条提示` : "";
      setExportState({
        tone: "normal",
        message: `已导出 ${formatBytes(result.sizeBytes)} 的 debug 包，共 ${result.includedFiles} 个文件${warningText}。Finder / 资源管理器已打开：${result.zipPath}`,
      });
    } catch (err) {
      setExportState({
        tone: "error",
        message: `导出 debug 包失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <SectionShell title="Debug" sub="前端事件、REST / Gateway 失败、Console 错误与异常捕获。">
      <div className={s.aboutHero}>
        <div className={s.aboutHeroMark}><Bug size={24} /></div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>Hermes Agent 中文社区桌面版排障包</div>
          <h3>一键导出 debug 包</h3>
          <p>{exportSubText}</p>
          {exportState && (
            <div className={s.runtimeMessage} data-tone={exportState.tone === "error" ? "error" : undefined}>
              {exportState.message}
            </div>
          )}
        </div>
        <div className={s.debugHeroActions}>
          <button className={s.btnPrimary} type="button" onClick={handleExport} disabled={!canExport || exporting}>
            {exporting ? <LoadingIndicator size="xs" /> : <FileArchive size={12} />}
            导出 debug 包
          </button>
          <span>
            <FolderOpen size={12} />
            {androidRemoteOnly ? "保存到 Android 系统文件位置" : "导出后自动打开所在文件夹"}
          </span>
        </div>
      </div>
      <DebugSection showHeading={false} />
    </SectionShell>
  );
}
