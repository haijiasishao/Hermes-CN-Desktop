import { useLocation } from "react-router-dom";
import { runtime } from "@/lib/runtime";

export type TopTab =
  | "workbench"
  | "skills"
  | "gateway"
  | "externalMemory"
  | "advanced";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

const isRoute = (path: string, route: string) => path === route || path.startsWith(`${route}/`);

/**
 * Return to the active conversation from configuration pages. The bare
 * workbench root remains the explicit new-session entry when no session is
 * active.
 */
export function workbenchHrefForSession(activeSessionId: string | null): string {
  return activeSessionId ? `/tasks/${encodeURIComponent(activeSessionId)}` : "/";
}

const ADVANCED_ROUTES = [
  "/common",
  "/notifications",
  "/config",
  "/connection",
  "/kernel",
  "/env",
  "/about",
  "/advanced",
  "/settings",
] as const;

export const TOP_TABS: readonly TopTabDef[] = [
  {
    id: "workbench",
    num: "01",
    label: "工作台",
    href: "/",
    matches: (path) =>
      path === "/" ||
      path.startsWith("/new") ||
      path.startsWith("/tasks/") ||
      path.startsWith("/history") ||
      path.startsWith("/projects") ||
      path.startsWith("/kanban"),
  },
  {
    id: "skills",
    num: "02",
    label: "配置",
    href: "/models",
    matches: (path) =>
      path.startsWith("/skills") ||
      path.startsWith("/backup") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models") ||
      path.startsWith("/voice") ||
      path.startsWith("/config-migration") ||
      path.startsWith("/soul") ||
      path.startsWith("/cron") ||
      path.startsWith("/console") ||
      path.startsWith("/coding-agents"),
  },
  {
    id: "gateway",
    num: "03",
    label: "消息接入",
    href: "/im/feishu",
    matches: (path) => path.startsWith("/im"),
  },
  {
    id: "externalMemory",
    num: "04",
    label: "记忆",
    href: "/memory",
    matches: (path) => ["/memory", "/memconfig", "/openviking", "/hindsight"].some((route) => isRoute(path, route)),
  },
  {
    id: "advanced",
    num: "05",
    label: "高级",
    href: "/health",
    matches: (path) =>
      path.startsWith("/health") ||
      path.startsWith("/analytics") ||
      path.startsWith("/logs") ||
      path.startsWith("/debug") ||
      path.startsWith("/theme") ||
      ADVANCED_ROUTES.some((route) => isRoute(path, route)),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = getVisibleTopTabs(runtime.androidRemoteOnly).find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}

/** Tab IDs hidden on Android Remote-only builds. */
export const ANDROID_REMOTE_HIDDEN_TAB_IDS: ReadonlySet<TopTab> = new Set<TopTab>([
  "gateway",
  "externalMemory",
]);

/**
 * Returns the top tabs visible for the current runtime.
 * On Android Remote-only builds, the message gateway and memory tabs are
 * hidden. The remote client does not own either the gateway setup UI or local
 * / external memory configuration.
 */
export function getVisibleTopTabs(androidRemoteOnly: boolean): readonly TopTabDef[] {
  if (!androidRemoteOnly) return TOP_TABS;
  return TOP_TABS.filter((tab) => !ANDROID_REMOTE_HIDDEN_TAB_IDS.has(tab.id));
}
