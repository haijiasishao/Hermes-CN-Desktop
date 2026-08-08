import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "use-sessions.ts"),
  "utf-8",
);

describe("useSessions: archived query parameter alignment", () => {
  it("uses archived=include for the server-side parameter when includeArchived is true", () => {
    // The server now expects archived=include instead of include_archived=true
    expect(source).toContain("archived=include");
  });

  it("does not use deprecated include_archived parameter", () => {
    // The old include_archived parameter should be replaced
    expect(source).not.toContain("include_archived=true");
  });
});
