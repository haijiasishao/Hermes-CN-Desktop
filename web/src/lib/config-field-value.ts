export type ConfigFieldParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatConfigFieldValue(fieldType: string, value: unknown): string {
  if (value == null) return "";
  if (fieldType === "list" || fieldType === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function parseConfigFieldValue(fieldType: string, raw: string): ConfigFieldParseResult {
  if (fieldType === "number") {
    if (!raw.trim()) return { ok: false, error: "请输入有效数字" };
    const value = Number(raw);
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, error: "请输入有效数字" };
  }

  if (fieldType === "boolean") return { ok: true, value: raw === "true" };

  if (fieldType === "list" || fieldType === "object") {
    try {
      const value: unknown = JSON.parse(raw);
      if (fieldType === "list" && !Array.isArray(value)) {
        return { ok: false, error: "请输入有效的 JSON 数组，例如 []" };
      }
      if (fieldType === "object" && !isPlainObject(value)) {
        return { ok: false, error: "请输入有效的 JSON 对象，例如 {}" };
      }
      return { ok: true, value };
    } catch {
      return {
        ok: false,
        error: fieldType === "list"
          ? "请输入有效的 JSON 数组，例如 []"
          : "请输入有效的 JSON 对象，例如 {}",
      };
    }
  }

  return { ok: true, value: raw };
}
