import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "settings-connection-section.tsx"),
  "utf-8",
);

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf(`const ${nextName}`, start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("RED: password/OAuth login activates Dashboard REST immediately", () => {
  it("applies the logged-in remote as OAuth before reporting auth restored", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain("applyConnectionConfig");
    expect(body).toContain('remoteAuthMode: "oauth"');
    expect(body.indexOf("applyConnectionConfig")).toBeLessThan(body.indexOf("notifyConnectionAuthRestored"));
  });
});
