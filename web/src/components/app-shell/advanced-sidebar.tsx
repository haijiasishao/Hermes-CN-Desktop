import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bell,
  Bug,
  Cable,
  Cpu,
  FileCog,
  FileText,
  HeartPulse,
  Info,
  MonitorCog,
  Palette,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";
import { runtime } from "@/lib/runtime";

interface AdvancedItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const OBSERVABILITY_ITEMS: readonly AdvancedItem[] = [
  { label: "健康检查", path: "/health", icon: HeartPulse },
  { label: "数据分析", path: "/analytics", icon: BarChart3 },
  { label: "日志", path: "/logs", icon: FileText },
  { label: "Debug", path: "/debug", icon: Bug },
];

export const ADVANCED_ITEMS: readonly AdvancedItem[] = [
  { label: "常规", path: "/common", icon: SlidersHorizontal },
  { label: "通知", path: "/notifications", icon: Bell },
  { label: "主题", path: "/theme", icon: Palette },
  { label: "配置", path: "/config", icon: FileCog },
  { label: "连接", path: "/connection", icon: Cable },
  { label: "内核", path: "/kernel", icon: Cpu },
  { label: "环境", path: "/env", icon: MonitorCog },
  { label: "关于", path: "/about", icon: Info },
];

export function getVisibleAdvancedItems(androidRemoteOnly: boolean): readonly AdvancedItem[] {
  if (!androidRemoteOnly) return ADVANCED_ITEMS;
  // Android Remote-only: the "/about" page renders the platform-specific
  // mobile build info instead of desktop update/DevTools content, so it stays
  // visible. Kernel & environment inspection remain desktop-owned.
  return ADVANCED_ITEMS.filter(
    (item) => item.path !== "/kernel" && item.path !== "/env",
  );
}

const SECTIONS: readonly {
  label: string;
  items: readonly AdvancedItem[];
}[] = [
  { label: "§051 · 可观测", items: OBSERVABILITY_ITEMS },
  { label: "§052 · 高级", items: ADVANCED_ITEMS },
];

export function AdvancedSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const visibleSections = [
    SECTIONS[0],
    { ...SECTIONS[1], items: getVisibleAdvancedItems(runtime.androidRemoteOnly) },
  ];

  return (
    <aside className={s.sidebar} aria-label="高级侧栏">
      <div className={s.scrollY}>
        {visibleSections.map((section) => (
          <section key={section.label} className={s.section}>
            <div className={s.label}>
              <span>{section.label}</span>
              <span className={s.labelNum}>✕✕</span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  onClick={() => navigate(item.path)}
                  title={item.path}
                >
                  <span className={s.itemIcon}>
                    <Icon size={16} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.path}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
