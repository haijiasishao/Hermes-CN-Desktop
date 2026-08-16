// Android system-back layer protocol (P6-C).
//
// The Kotlin shell calls a synchronous `window.__hermesBackRequest()` when the
// user presses the system back button. The return value tells the shell whether
// the frontend consumed the press:
//
//   true  → the frontend closed an overlay / navigated back; shell must NOT exit
//   false → nothing open, no SPA history left; shell may finish() the Activity
//
// The frontend consumes in layer order (highest priority first):
//   1. registered back consumers (command palette, mobile drawer, mobile
//      history detail view, ...) — LIFO so the topmost overlay closes first
//   2. Radix dialog/popover content in the DOM → dispatch Escape so Radix
//      dismisses it through its own handlers
//   3. SPA history (HashRouter on Android) → history.back()
//   4. otherwise → false (shell exits)
//
// Consumers register with registerBackConsumer() and must return truthy when
// they actually closed something.

export type BackConsumer = () => boolean | void;

const consumers: BackConsumer[] = [];

/**
 * Register a back-press consumer. Higher-priority consumers added later run
 * first (LIFO). Return the unregister function.
 */
export function registerBackConsumer(consumer: BackConsumer): () => void {
  consumers.push(consumer);
  return () => {
    const index = consumers.indexOf(consumer);
    if (index >= 0) consumers.splice(index, 1);
  };
}

/**
 * Test-only helper: clear the registered consumer stack. Consumers are
 * module-scoped state; unit tests need an empty slate between cases.
 */
export function clearBackConsumersForTests(): void {
  consumers.length = 0;
}

/** True when any Radix dialog/popover content is currently mounted. */
function hasRadixOverlayContent(): boolean {
  return Boolean(
    document.querySelector(
      '[data-radix-dialog-content], [data-radix-dialog-overlay], [data-radix-popover-content]',
    ),
  );
}

/**
 * The synchronous handler invoked by the Kotlin shell.
 * See module doc for the layer order.
 */
export function handleAndroidBackRequest(): boolean {
  // 1. Explicit consumers (topmost overlay first).
  for (let index = consumers.length - 1; index >= 0; index -= 1) {
    if (consumers[index]()) return true;
  }

  // 2. Radix overlay fallback: dispatch Escape; Radix dismisses via its own
  //    document-level keydown listener.
  if (hasRadixOverlayContent()) {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    return true;
  }

  // 3. SPA history (HashRouter keeps real history entries per navigation).
  if (window.history.length > 1) {
    window.history.back();
    return true;
  }

  // 4. Nothing to consume.
  return false;
}

export function installAndroidBackRequest(): void {
  (window as unknown as Record<string, unknown>).__hermesBackRequest = handleAndroidBackRequest;
}
