const ANDROID_REMOTE_ROUTE_REDIRECTS: Readonly<Record<string, string>> = {
  "/memory": "/memconfig",
  "/kernel": "/health",
  "/env": "/health",
  "/advanced/kernel": "/health",
  "/advanced/env": "/health",
};

/**
 * Return the safe remote replacement for a desktop-only route, or null when
 * the route is supported or the current shell is not Android Remote-only.
 */
export function getAndroidRemoteRouteRedirect(pathname: string, androidRemoteOnly: boolean): string | null {
  if (!androidRemoteOnly) return null;
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ANDROID_REMOTE_ROUTE_REDIRECTS[normalized] ?? null;
}
