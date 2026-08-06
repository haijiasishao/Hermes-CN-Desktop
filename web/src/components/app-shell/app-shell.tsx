import type { ReactNode } from "react";
import { useEffect } from "react";
import { useAtom } from "jotai";
import { useLocation } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { IconButton } from "@hermes/shared-ui";
import { appSidebarVisibleAtom } from "@/stores/ui";
import { useIsMobile } from "@/hooks/use-media-query";
import { AppTopBar } from "./app-top-bar";
import { AppSidebar } from "./app-sidebar";
import { AppStatusBar } from "./app-status-bar";
import { ConnectionTargetNotice } from "./connection-target-notice";
import { ModelOnboardingDialog } from "./model-onboarding-dialog";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarVisible, setSidebarVisible] = useAtom(appSidebarVisibleAtom);
  const isMobile = useIsMobile();
  const { pathname } = useLocation();

  // On mobile, auto-collapse the sidebar drawer after navigation.
  useEffect(() => {
    if (isMobile && sidebarVisible) setSidebarVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, isMobile]);

  const toggleLabel = sidebarVisible ? "隐藏左侧边栏" : "显示左侧边栏";

  return (
    <div
      className={s.shell}
      data-sidebar-visible={sidebarVisible ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
    >
      <div className={s.topbarSlot}>
        <AppTopBar />
      </div>
      <div
        id="app-sidebar"
        className={s.sidebarSlot}
        aria-hidden={sidebarVisible ? undefined : true}
        inert={sidebarVisible ? undefined : true}
      >
        <AppSidebar />
        {sidebarVisible ? (
          <IconButton
            className={s.sidebarToggle}
            variant="outline"
            size="xs"
            aria-label={toggleLabel}
            aria-controls="app-sidebar"
            aria-expanded="true"
            title={toggleLabel}
            onClick={() => setSidebarVisible(false)}
          >
            {isMobile ? <X size={16} /> : <PanelLeftClose size={12} />}
          </IconButton>
        ) : null}
      </div>
      {isMobile && sidebarVisible ? (
        <button
          type="button"
          className={s.sidebarBackdrop}
          aria-label="关闭侧边栏"
          tabIndex={-1}
          onClick={() => setSidebarVisible(false)}
        />
      ) : null}
      <div className={s.mainSlot}>
        <ConnectionTargetNotice />
        {children}
        <ModelOnboardingDialog />
      </div>
      <div className={s.statusbarSlot}>
        <AppStatusBar />
      </div>
      <IconButton
        className={s.sidebarRestoreButton}
        data-visible={sidebarVisible ? "false" : "true"}
        data-mobile={isMobile ? "true" : "false"}
        variant="outline"
        size="xs"
        aria-label="显示左侧边栏"
        aria-controls="app-sidebar"
        aria-expanded={sidebarVisible ? "true" : "false"}
        aria-hidden={sidebarVisible ? true : undefined}
        disabled={sidebarVisible}
        tabIndex={sidebarVisible ? -1 : 0}
        title="显示左侧边栏"
        onClick={() => setSidebarVisible(true)}
      >
        <PanelLeftOpen size={12} />
      </IconButton>
    </div>
  );
}
