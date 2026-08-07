import { useNavigate, useLocation } from "react-router-dom";
import { Moon, Search, Sun } from "lucide-react";
import { useTheme } from "@hermes/shared-ui";
import { useCommandPalette } from "@/components/command-palette";
import { ProfileSelector } from "@/components/sidebar/profile-selector";
import { getVisibleTopTabs } from "./use-active-top-tab";
import { runtime } from "@/lib/runtime";
import s from "./app-top-bar.module.css";

export function AppTopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config: themeConfig, update: updateTheme } = useTheme();
  const { openCommandPalette } = useCommandPalette();
  const isDarkTheme = ["dark", "dark-modern", "dracula", "catppuccin-mocha"].includes(themeConfig.theme);
  const nextTheme = isDarkTheme ? "light-modern" : "dark-modern";
  const ThemeIcon =
    isDarkTheme ? Sun : Moon;
  const themeToggleLabel = `切换到${isDarkTheme ? "浅色" : "深色"}模式`;
  const visibleTopTabs = getVisibleTopTabs(runtime.androidRemoteOnly);

  return (
    <header className={s.topbar} data-window-drag data-tauri-drag-region="deep">
      <div className={s.brand}>
        <span className={s.brandText}>
          <span className={s.wordmark}>Hermes Agent</span>
          <span className={s.brandMeta}>
            <span className={s.edition}>中文社区桌面版</span>
            <span className={s.metaDot} aria-hidden="true">·</span>
            <span className={s.site}>hermesagent.org.cn</span>
          </span>
        </span>
      </div>

      <nav className={s.nav} aria-label="主导航">
        {visibleTopTabs.map((tab) => (
          <a
            key={tab.id}
            href={tab.href}
            className={s.navLink}
            data-active={tab.matches(location.pathname) ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(tab.href);
            }}
          >
            <span className={s.navNum}>{tab.num}</span>
            {tab.label}
          </a>
        ))}
      </nav>

      <button
        type="button"
        className={s.search}
        onClick={openCommandPalette}
        title="搜索命令 / 会话 / 文件"
        data-no-drag
      >
        <Search size={12} />
        <span>搜索命令 / 会话 / 文件…</span>
        <span className={s.searchKbd}>⌘ K</span>
      </button>

      <div className={s.actions}>
        <ProfileSelector variant="topbar" />
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => updateTheme({ theme: nextTheme })}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
          data-theme-mode={themeConfig.theme}
        >
          <ThemeIcon size={16} />
        </button>
      </div>
    </header>
  );
}
