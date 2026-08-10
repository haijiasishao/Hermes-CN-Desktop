import type React from "react";
import { useEffect, useRef } from "react";

// ── Pure logic (testable without DOM) ──

export interface LongPressConfig {
  /** Delay in ms before the long-press fires. Default 500. */
  delay?: number;
  /** Maximum pointer displacement (px) before cancel. Default 10. */
  moveThreshold?: number;
}

export interface LongPressState {
  timer: ReturnType<typeof setTimeout> | null;
  startX: number;
  startY: number;
  fired: boolean;
}

export function createLongPressState(): LongPressState {
  return { timer: null, startX: 0, startY: 0, fired: false };
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

/**
 * Begin tracking a potential long-press.
 * @returns true if a timer was started, false if already pending.
 */
export function startPending(
  state: LongPressState,
  x: number,
  y: number,
  delay: number,
  onFire: () => void,
): boolean {
  if (state.timer != null) return false;
  state.startX = x;
  state.startY = y;
  state.fired = false;
  state.timer = setTimeout(() => {
    state.fired = true;
    state.timer = null;
    onFire();
  }, delay);
  return true;
}

/** Cancel a pending long-press and return whether it had not yet fired. */
export function cancelPending(state: LongPressState): boolean {
  if (state.timer != null) {
    clearTimeout(state.timer);
    state.timer = null;
    return true;
  }
  return false;
}

/**
 * Check pointer displacement against the threshold.
 * @returns true if the pending long-press was cancelled due to movement.
 */
export function checkMove(
  state: LongPressState,
  x: number,
  y: number,
  threshold: number,
): boolean {
  if (state.timer == null) return false;
  if (distance(state.startX, state.startY, x, y) > threshold) {
    cancelPending(state);
    return true;
  }
  return false;
}

/** Reset all state (e.g. on unmount or after a completed interaction). */
export function resetLongPress(state: LongPressState): void {
  if (state.timer != null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.fired = false;
}

// ── React hook ──

export interface LongPressHandlers {
  onTouchStart: React.TouchEventHandler<HTMLElement>;
  onTouchMove: React.TouchEventHandler<HTMLElement>;
  onTouchEnd: React.TouchEventHandler<HTMLElement>;
  onTouchCancel: React.TouchEventHandler<HTMLElement>;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerUp: React.PointerEventHandler<HTMLElement>;
  onPointerCancel: React.PointerEventHandler<HTMLElement>;
  onContextMenu: React.MouseEventHandler<HTMLElement>;
}

/**
 * Hook that returns event handlers for detecting a long-press gesture.
 *
 * The `callback` receives the triggering event so the caller can determine
 * which element (via `data-session-id`) was long-pressed and where (clientX/Y).
 *
 * Works on both touch (touchstart/touchmove/touchend) and pointer events
 * (pointerdown/pointermove/pointerup) for broad device coverage.
 */
export function useLongPress(
  callback: (e: TouchEvent | PointerEvent) => void,
  config?: LongPressConfig,
): LongPressHandlers {
  const { delay = 500, moveThreshold = 10 } = config ?? {};
  const state = useRef(createLongPressState());
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => () => resetLongPress(state.current), []);

  return {
    onTouchStart(e) {
      const ne = e.nativeEvent;
      const t = ne.touches[0];
      if (t) startPending(state.current, t.clientX, t.clientY, delay, () => cbRef.current(ne));
    },
    onTouchMove(e) {
      const ne = e.nativeEvent;
      const t = ne.touches[0];
      if (t) checkMove(state.current, t.clientX, t.clientY, moveThreshold);
    },
    onTouchEnd(e) {
      // If the timer hasn't fired yet (finger lifted before delay), cancel.
      if (state.current.timer != null) {
        cancelPending(state.current);
      }
      // Reset fired flag after a tick so the click guard can read it.
      setTimeout(() => { state.current.fired = false; }, 0);
    },
    onTouchCancel() {
      cancelPending(state.current);
      state.current.fired = false;
    },
    onPointerDown(e) {
      // Ignore pointer events triggered by touch to avoid double-firing.
      if (e.nativeEvent.pointerType === "touch") return;
      startPending(state.current, e.clientX, e.clientY, delay, () => cbRef.current(e.nativeEvent));
    },
    onPointerMove(e) {
      if (e.nativeEvent.pointerType === "touch") return;
      checkMove(state.current, e.clientX, e.clientY, moveThreshold);
    },
    onPointerUp(e) {
      if (e.nativeEvent.pointerType === "touch") return;
      if (state.current.timer != null) {
        cancelPending(state.current);
      }
      setTimeout(() => { state.current.fired = false; }, 0);
    },
    onPointerCancel() {
      cancelPending(state.current);
      state.current.fired = false;
    },
    onContextMenu(e) {
      // Prevent browser context menu on long-press on Android.
      e.preventDefault();
      cancelPending(state.current);
      state.current.fired = false;
    },
  };
}
