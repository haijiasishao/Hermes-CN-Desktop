import { afterEach, describe, expect, it, vi } from "vitest";
import { installKeyboardViewportAdapter } from "./keyboard-viewport";

/**
 * node-based tests: visualViewport / window / document are faked through
 * globalThis, mirroring the android-back-request test pattern.
 */

function installFakeDom(options: { vvHeight: number; innerHeight: number }) {
  const vvListeners: Record<string, () => void> = {};
  const windowListeners: Record<string, () => void> = {};
  const vv = {
    height: options.vvHeight,
    addEventListener: vi.fn((type: string, cb: () => void) => {
      vvListeners[type] = cb;
    }),
    removeEventListener: vi.fn(),
  };
  const windowObj = {
    innerHeight: options.innerHeight,
    visualViewport: vv,
    addEventListener: vi.fn((type: string, cb: () => void) => {
      windowListeners[type] = cb;
    }),
    removeEventListener: vi.fn(),
  };
  const root: { dataset: Record<string, string> } = { dataset: {} };
  (globalThis as Record<string, unknown>).window = windowObj;
  (globalThis as Record<string, unknown>).document = {
    documentElement: root,
    activeElement: null as unknown,
  };
  return { vv, vvListeners, windowListeners, root, windowObj };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  vi.restoreAllMocks();
});

describe("keyboard-viewport (P6-D mobile keyboard adaptation)", () => {
  it("returns a no-op uninstaller without visualViewport (desktop)", () => {
    (globalThis as Record<string, unknown>).window = { visualViewport: null };
    const uninstall = installKeyboardViewportAdapter();
    expect(typeof uninstall).toBe("function");
    uninstall();
  });

  it("subscribes to visualViewport and window resize", () => {
    const { vv, windowObj } = installFakeDom({ vvHeight: 800, innerHeight: 800 });
    const uninstall = installKeyboardViewportAdapter();
    expect(vv.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(windowObj.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    uninstall();
  });

  it("marks data-keyboard-open when visual viewport shrinks ≥20%", () => {
    const { vv, vvListeners, root } = installFakeDom({ vvHeight: 800, innerHeight: 800 });
    installKeyboardViewportAdapter();
    const resizeHandler = vvListeners["resize"];

    vv.height = 600; // 25% shrink — keyboard open
    resizeHandler();
    expect(root.dataset.keyboardOpen).toBe("true");

    vv.height = 800; // keyboard closed
    resizeHandler();
    expect(root.dataset.keyboardOpen).toBeUndefined();
  });

  it("does not mark keyboard open for small shrinks (<20%)", () => {
    const { vv, vvListeners, root } = installFakeDom({ vvHeight: 800, innerHeight: 800 });
    installKeyboardViewportAdapter();
    vv.height = 700; // 12.5% shrink
    vvListeners["resize"]();
    expect(root.dataset.keyboardOpen).toBeUndefined();
  });

  it("uninstall removes listeners and clears the marker", () => {
    const { vv, vvListeners, root, windowObj } = installFakeDom({
      vvHeight: 800,
      innerHeight: 800,
    });
    const uninstall = installKeyboardViewportAdapter();
    vv.height = 600;
    vvListeners["resize"]();
    expect(root.dataset.keyboardOpen).toBe("true");

    uninstall();
    expect(vv.removeEventListener).toHaveBeenCalled();
    expect(windowObj.removeEventListener).toHaveBeenCalled();
    expect(root.dataset.keyboardOpen).toBeUndefined();
  });
});
