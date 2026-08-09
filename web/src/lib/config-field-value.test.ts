import { describe, expect, it } from "vitest";
import { formatConfigFieldValue, parseConfigFieldValue } from "./config-field-value";

describe("config field structured values", () => {
  it("formats lists and objects as readable JSON", () => {
    expect(formatConfigFieldValue("list", [{ provider: "openai", model: "gpt-5" }])).toBe(
      '[\n  {\n    "provider": "openai",\n    "model": "gpt-5"\n  }\n]',
    );
    expect(formatConfigFieldValue("object", { enabled: true })).toBe('{\n  "enabled": true\n}');
  });

  it("parses list JSON without degrading it to a string", () => {
    expect(parseConfigFieldValue("list", '[{"provider":"openai"}]')).toEqual({
      ok: true,
      value: [{ provider: "openai" }],
    });
  });

  it("rejects a non-array value for a list field", () => {
    expect(parseConfigFieldValue("list", '{"provider":"openai"}')).toEqual({
      ok: false,
      error: "请输入有效的 JSON 数组，例如 []",
    });
  });

  it("accepts plain objects and rejects arrays for object fields", () => {
    expect(parseConfigFieldValue("object", '{"enabled":true}')).toEqual({
      ok: true,
      value: { enabled: true },
    });
    expect(parseConfigFieldValue("object", "[]")).toEqual({
      ok: false,
      error: "请输入有效的 JSON 对象，例如 {}",
    });
  });

  it("keeps scalar parsing behavior explicit", () => {
    expect(parseConfigFieldValue("number", "42")).toEqual({ ok: true, value: 42 });
    expect(parseConfigFieldValue("string", " clean/new-api ")).toEqual({
      ok: true,
      value: " clean/new-api ",
    });
  });
});
