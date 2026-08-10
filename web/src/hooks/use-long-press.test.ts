import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createLongPressState,
  startPending,
  cancelPending,
  checkMove,
  resetLongPress,
  type LongPressState,
} from "./use-long-press";

describe("long-press pure logic", () => {
  let state: LongPressState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = createLongPressState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createLongPressState", () => {
    it("returns initial state with no timer and fired=false", () => {
      expect(state.timer).toBeNull();
      expect(state.startX).toBe(0);
      expect(state.startY).toBe(0);
      expect(state.fired).toBe(false);
    });
  });

  describe("startPending", () => {
    it("stores start coordinates and returns true on first call", () => {
      const onFire = vi.fn();
      expect(startPending(state, 120, 300, 500, onFire)).toBe(true);
      expect(state.startX).toBe(120);
      expect(state.startY).toBe(300);
      expect(state.timer).not.toBeNull();
      expect(state.fired).toBe(false);
    });

    it("returns false when a timer is already pending (no double-start)", () => {
      const onFire = vi.fn();
      startPending(state, 100, 100, 500, onFire);
      expect(startPending(state, 200, 200, 500, onFire)).toBe(false);
    });

    it("fires callback after delay and sets fired=true", () => {
      const onFire = vi.fn();
      startPending(state, 50, 50, 500, onFire);
      expect(onFire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(state.fired).toBe(true);
      expect(state.timer).toBeNull();
    });

    it("does not fire callback before delay elapses", () => {
      const onFire = vi.fn();
      startPending(state, 50, 50, 500, onFire);
      vi.advanceTimersByTime(499);
      expect(onFire).not.toHaveBeenCalled();
      expect(state.fired).toBe(false);
    });
  });

  describe("cancelPending", () => {
    it("cancels a pending timer and returns true", () => {
      const onFire = vi.fn();
      startPending(state, 50, 50, 500, onFire);
      expect(cancelPending(state)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(onFire).not.toHaveBeenCalled();
    });

    it("returns false when no timer is pending", () => {
      expect(cancelPending(state)).toBe(false);
    });
  });

  describe("checkMove", () => {
    it("cancels pending long-press when displacement exceeds threshold", () => {
      const onFire = vi.fn();
      startPending(state, 100, 100, 500, onFire);
      // Move 20px diagonally (> 10px threshold)
      expect(checkMove(state, 120, 120, 10)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(onFire).not.toHaveBeenCalled();
    });

    it("does not cancel when displacement is within threshold", () => {
      const onFire = vi.fn();
      startPending(state, 100, 100, 500, onFire);
      // Move only 5px (within 10px threshold)
      expect(checkMove(state, 103, 104, 10)).toBe(false);
      expect(state.timer).not.toBeNull();
    });

    it("returns false when no timer is pending", () => {
      expect(checkMove(state, 200, 200, 10)).toBe(false);
    });
  });

  describe("resetLongPress", () => {
    it("clears timer and resets fired flag", () => {
      const onFire = vi.fn();
      startPending(state, 50, 50, 500, onFire);
      resetLongPress(state);
      expect(state.timer).toBeNull();
      expect(state.fired).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(onFire).not.toHaveBeenCalled();
    });

    it("is safe to call when already idle", () => {
      expect(() => resetLongPress(state)).not.toThrow();
    });
  });
});
