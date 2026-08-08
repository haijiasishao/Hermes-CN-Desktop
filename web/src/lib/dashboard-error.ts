function jsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "" : serialized;
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = isRecord(error)
      ? [error.raw, error.details, error.cause].filter((value) => value !== undefined).map(jsonText)
      : [];
    return [error.message, ...extra].filter(Boolean).join(" ");
  }
  if (typeof error === "string") return error;
  return jsonText(error) || String(error ?? "");
}

export function errorStatus(error: unknown): number | undefined {
  const candidates: unknown[] = [error];
  const seen = new Set<object>();
  while (candidates.length > 0) {
    const current = candidates.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["status", "statusCode", "httpStatus"]) {
      const value = current[key];
      const numeric = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(numeric) && numeric > 0) return numeric;
    }
    for (const key of ["raw", "details", "cause", "error"]) {
      if (current[key] !== undefined) candidates.push(current[key]);
    }
  }
  return undefined;
}

export function isDashboardAuthError(error: unknown): boolean {
  const text = errorText(error);
  const status = errorStatus(error);
  return status === 401 || /\b(?:HTTP\s*)?401\b/i.test(text) ||
    /unauthenticated|no_cookie|session_expired|login_url/i.test(text);
}

export function dashboardAuthErrorMessage(subject = "远程 Dashboard"): string {
  return `${subject} 登录状态无效，请打开连接设置重新登录（用户名/密码）后重试。`;
}
