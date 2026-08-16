// Mobile on-screen keyboard adaptation (P6-D).
//
// Android WebView with `windowSoftInputMode=adjustResize` resizes the layout
// viewport, and the app shell now prefers `100dvh` (dynamic viewport height)
// so the composer stays visible while the keyboard is open. Older WebView
// versions / iOS quirks may still keep `100vh` larger than the visual
// viewport; this module is the belt-and-braces fallback:
//
//   - listens to `visualViewport` resizes
//   - when the keyboard collapses the visual viewport (height shrinks by
//     ≥20% vs the layout viewport), marks `document.documentElement` with
//     `data-keyboard-open` and scrolls the focused input into view
//   - clears the marker when the keyboard closes

const KEYBOARD_SHRINK_RATIO = 0.2;

function visualViewport(): VisualViewport | null {
  return typeof window !== "undefined" ? window.visualViewport ?? null : null;
}

function focusedEditable(): HTMLElement | null {
  const el = document.activeElement;
  if (!el) return null;
  // Guard the constructor references: node/jsdom-like environments (unit
  // tests) may not define these globals.
  const hasTextarea = typeof HTMLTextAreaElement !== "undefined";
  const hasInput = typeof HTMLInputElement !== "undefined";
  const hasElement = typeof HTMLElement !== "undefined";
  if (
    (hasTextarea && el instanceof HTMLTextAreaElement) ||
    (hasInput && el instanceof HTMLInputElement)
  ) {
    return el as HTMLElement;
  }
  if (hasElement && el instanceof HTMLElement && el.isContentEditable) return el;
  return null;
}

function onVisualViewportResize(): void {
  const vv = visualViewport();
  if (!vv) return;

  const layoutHeight = window.innerHeight || document.documentElement.clientHeight;
  const shrunk = layoutHeight > 0 && vv.height < layoutHeight * (1 - KEYBOARD_SHRINK_RATIO);

  const root = document.documentElement;
  if (shrunk) {
    root.dataset.keyboardOpen = "true";
    const editable = focusedEditable();
    if (editable) {
      editable.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  } else {
    delete root.dataset.keyboardOpen;
  }
}

export function installKeyboardViewportAdapter(): () => void {
  const vv = visualViewport();
  if (!vv) return () => undefined;
  vv.addEventListener("resize", onVisualViewportResize);
  // Also react to layout viewport changes (orientation, resize) so the marker
  // is cleared when the user rotates or restores the window.
  window.addEventListener("resize", onVisualViewportResize);
  return () => {
    vv.removeEventListener("resize", onVisualViewportResize);
    window.removeEventListener("resize", onVisualViewportResize);
    delete document.documentElement.dataset.keyboardOpen;
  };
}
