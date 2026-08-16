// Kotlin-native bridge adapter for the Android rebuild.
//
// The Android app no longer ships Rust/Tauri: MainActivity injects
// `window.HermesBridge` (a Kotlin @JavascriptInterface object) with
//
//   HermesBridge.invoke(command: string, argsJson: string, callbackId: string)
//
// Results are delivered asynchronously through
//   window.__hermesBridgeResolve(callbackId, resultJson)
//   window.__hermesBridgeReject (callbackId, errorJson)
// and native → JS events through
//   window.__hermesBridgeEmit(eventName, payloadJson)
//
// This module mirrors the tiny subset of the @tauri-apps/api surface the
// frontend bridge consumes (invoke + listen + unlisten semantics), so
// `tauri-bridge.ts` and `gateway-relay-socket.ts` switch between the Tauri
// and Kotlin transports without changing any business code or tests.

let nativeSeq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(event: unknown) => void>>();
let handlersInstalled = false;

export function isNativeBridge(): boolean {
  try {
    return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).HermesBridge;
  } catch {
    return false;
  }
}

function nativeBridge(): { invoke: (c: string, a: string, id: string) => void } {
  return (window as unknown as {
    HermesBridge: { invoke: (c: string, a: string, id: string) => void };
  }).HermesBridge;
}

/** Async invoke over the Kotlin bridge, Promise-compatible with Tauri invoke. */
export function nativeInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureHandlersInstalled();
  return new Promise<T>((resolve, reject) => {
    const id = `hb-${Date.now()}-${++nativeSeq}`;
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject: (e) => reject(e),
    });
    try {
      nativeBridge().invoke(command, JSON.stringify(args ?? {}), id);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Subscribe to a native event (Kotlin emit → __hermesBridgeEmit). Returns an unlisten fn. */
export async function nativeListen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const set = listeners.get(event) ?? new Set<(event: unknown) => void>();
  const wrapped = (payload: unknown) => handler(payload as T);
  set.add(wrapped);
  listeners.set(event, set);
  return () => {
    const s = listeners.get(event);
    if (s) {
      s.delete(wrapped);
      if (s.size === 0) listeners.delete(event);
    }
  };
}

/** Install global resolve/reject/emit handlers. Call once before React mounts. */
export function installNativeBridgeHandlers(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;

  if (w.__hermesBridgeResolve || w.__hermesBridgeReject || w.__hermesBridgeEmit) return;

  w.__hermesBridgeResolve = (id: string, resultJson: unknown) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    try {
      const value = typeof resultJson === "string" && resultJson !== ""
        ? JSON.parse(resultJson)
        : resultJson;
      item.resolve(value);
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  w.__hermesBridgeReject = (id: string, errorJson: unknown) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    let message = String(errorJson ?? "native command error");
    let code: string | undefined;
    if (typeof errorJson === "string") {
      try {
        const parsed = JSON.parse(errorJson) as { message?: string; code?: string };
        if (parsed && typeof parsed.message === "string") message = parsed.message;
        if (parsed && typeof parsed.code === "string") code = parsed.code;
      } catch {
        // plain string message
      }
    }
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    item.reject(err);
  };

  w.__hermesBridgeEmit = (eventName: string, payloadJson: unknown) => {
    const set = listeners.get(String(eventName));
    if (!set) return;
    let payload: unknown = payloadJson;
    if (typeof payloadJson === "string" && payloadJson !== "") {
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        // keep raw string
      }
    }
    set.forEach((handler) => {
      try {
        handler({ payload } as { payload: unknown });
      } catch {
        // listener errors must not break other listeners
      }
    });
  };
}

/** Re-export the Tauri-compatible `listen` signature for adapters. */
export function nativeTransportAvailable(): boolean {
  return isNativeBridge();
}

/** Idempotent lazy install so nativeInvoke works even before the explicit install call. */
function ensureHandlersInstalled(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  installNativeBridgeHandlers();
}
