import { forwardRef, type ReactNode } from "react";
import { Button, cn, type ButtonProps } from "@hermes/shared-ui";
import s from "./top-bar.module.css";

interface TopBarProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  /** When true, the top bar renders in a two-row stacked layout on mobile. */
  mobileStack?: boolean;
}

type TopBarActionButtonProps = Omit<ButtonProps, "size">;

export function TopBar({ title, sub, right, mobileStack }: TopBarProps) {
  return (
    <div
      className={s.topBar}
      data-window-drag
      data-tauri-drag-region="deep"
      data-mobile-stack={mobileStack ? "true" : undefined}
    >
      <div className={s.inner}>
        <div className={s.titleGroup}>
          {title && <span className={s.title}>{title}</span>}
          {sub && <span className={s.sub}>{sub}</span>}
        </div>
        <span className={s.spacer} />
        {right && <div className={s.actions}>{right}</div>}
      </div>
    </div>
  );
}

export const TopBarActionButton = forwardRef<HTMLButtonElement, TopBarActionButtonProps>(
  function TopBarActionButton(
    { className, type = "button", variant = "plain", ...props },
    ref,
  ) {
    return (
      <Button
        {...props}
        ref={ref}
        type={type}
        variant={variant}
        size="sm"
        className={cn(s.chip, className)}
      />
    );
  },
);

export function TopBarActions() {
  return null;
}
