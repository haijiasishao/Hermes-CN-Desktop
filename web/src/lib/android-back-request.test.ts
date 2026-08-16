import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBackConsumersForTests,
  handleAndroidBackRequest,
  installAndroidBackRequest,
  registerBackConsumer,
} from "./android-back-request";

/**
 * Project tests run in node (no jsdom). The back-request module touches
 * window/document only at call time, so we inject minimal fakes through
 * globalThis, matching the pattern used by android-remote-regression.test.ts.
 */

function installFakeGlobalDom(overrides: {
  querySelector?: (selector: string) => Element | null;
  historyLength?: number;
  historyBack?: () => void;
} = {}) {
  const dispatchEvent = vi.fn();
  const querySelector = overrides.querySelector ?? vi.fn(() => null);
  const historyBack = overrides.historyBack ?? vi.fn();
  (globalThis as Record<string, unknown>).window = {
    history: { length: overrides.historyLength ?? 1, back: historyBack },
  };
  (globalThis as Record<string, unknown>).document = {
    querySelector,
    dispatchEvent,
  };
  // node has no KeyboardEvent; the module news one up when dismissing Radix
  // overlays, so provide a minimal stand-in capturing init params.
  class FakeKeyboardEvent {
    type: string;
    key: string;
    bubbles: boolean;
    cancelable: boolean;
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      this.key = String(init.key ?? "");
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
    }
  }
  (globalThis as Record<string, unknown>).KeyboardEvent = FakeKeyboardEvent;
  return { dispatchEvent, querySelector, historyBack };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).KeyboardEvent;
  clearBackConsumersForTests();
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearBackConsumersForTests();
});

describe("android-back-request (P6-C system back layer protocol)", () => {
  it("installs the synchronous __hermesBackRequest handler on window", () => {
    installFakeGlobalDom();
    installAndroidBackRequest();
    const installed = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
    expect(typeof installed.__hermesBackRequest).toBe("function");
    expect((installed.__hermesBackRequest as Function)()).toBe(false);
  });
  it("returns false when nothing is open and there is no SPA history", () => {
    const { historyBack } = installFakeGlobalDom({ historyLength: 1 });
    expect(handleAndroidBackRequest()).toBe(false);
    expect(historyBack).not.toHaveBeenCalled();
  });

  it("consumes via a registered consumer (LIFO) and returns true", () => {
    installFakeGlobalDom();
    const closed: string[] = [];
    const unregisterBottom = registerBackConsumer(() => {
      closed.push("bottom");
      return true;
    });
    const unregisterTop = registerBackConsumer(() => {
      closed.push("top");
      return true;
    });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(closed).toEqual(["top"]);

    unregisterTop();
    expect(handleAndroidBackRequest()).toBe(true);
    expect(closed).toEqual(["top", "bottom"]);

    unregisterBottom();
  });

  it("skips consumers that do not consume and continues down the stack", () => {
    installFakeGlobalDom();
    const calls: string[] = [];
    // LIFO: the later-registered consumer runs first. Register the closer
    // first so the pass-through (false) is on top and gets tried, then the
    // walk continues down to the closer.
    registerBackConsumer(() => {
      calls.push("closer");
      return true;
    });
    registerBackConsumer(() => {
      calls.push("pass-through");
      return false;
    });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(calls).toEqual(["pass-through", "closer"]);
  });

  it("dismisses Radix dialog content via dispatched Escape when no consumer", () => {
    const content = { getAttribute: () => null } as unknown as Element;
    const { dispatchEvent } = installFakeGlobalDom({
      querySelector: (selector) => (selector.includes("dialog") ? (content as Element) : null),
    });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as KeyboardEvent;
    expect(event.type).toBe("keydown");
    expect(event.key).toBe("Escape");
    expect(event.bubbles).toBe(true);
  });

  it("dismisses Radix popover content via dispatched Escape", () => {
    const popover = { getAttribute: () => null } as unknown as Element;
    const { dispatchEvent } = installFakeGlobalDom({
      querySelector: (selector) => (selector.includes("popover") ? (popover as Element) : null),
    });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("walks SPA history with history.back() when no overlay is open", () => {
    const { historyBack } = installFakeGlobalDom({ historyLength: 3 });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(historyBack).toHaveBeenCalledTimes(1);
  });

  it("prefers consumers over Radix overlays over SPA history", () => {
    const content = { getAttribute: () => null } as unknown as Element;
    installFakeGlobalDom({
      querySelector: (selector) => (selector.includes("dialog") ? (content as Element) : null),
      historyLength: 5,
    });

    const consumed: string[] = [];
    registerBackConsumer(() => {
      consumed.push("consumer");
      return true;
    });

    expect(handleAndroidBackRequest()).toBe(true);
    expect(consumed).toEqual(["consumer"]);
  });

  it("falls through non-consuming consumers to Radix Escape before history", () => {
    const content = { getAttribute: () => null } as unknown as Element;
    const { dispatchEvent, historyBack } = installFakeGlobalDom({
      querySelector: (selector) => (selector.includes("dialog") ? (content as Element) : null),
      historyLength: 2,
    });

    registerBackConsumer(() => false);

    expect(handleAndroidBackRequest()).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(historyBack).not.toHaveBeenCalled();
  });
});
