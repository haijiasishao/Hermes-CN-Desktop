import { describe, expect, it, vi } from "vitest";
import { McpServersFullResponse } from "@hermes/protocol";
import { MCP_SERVERS_ENDPOINT, summarizeMcpServers } from "./use-mcp-servers";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
}));

// Verify that McpServersFullResponse parses the upstream /api/mcp/servers shape
// and that the hook's mapping logic produces the expected McpServersResponse shape.
// This is a protocol-level regression: the old /api/mcp-servers endpoint returned
// a different schema, so we ensure McpServersFullResponse handles the new one.
describe("useMcpServers endpoint migration", () => {
  it("uses the Dashboard's current MCP servers endpoint", () => {
    expect(MCP_SERVERS_ENDPOINT).toBe("/api/mcp/servers");
  });

  it("McpServersFullResponse parses /api/mcp/servers upstream shape", () => {
    const upstream = {
      servers: [
        { name: "github", transport: "http", url: "https://mcp.github.com", enabled: true, args: [], env: {} },
        { name: "slack", transport: "stdio", command: "mcp-slack", enabled: false, args: [], env: {} },
        { name: "jira", transport: "http", url: null, enabled: true, args: [], env: {} },
      ],
    };
    const parsed = McpServersFullResponse.parse(upstream);
    expect(parsed.servers).toHaveLength(3);
    expect(parsed.servers[0]!.name).toBe("github");
    expect(parsed.servers[0]!.enabled).toBe(true);
    expect(parsed.servers[1]!.name).toBe("slack");
    expect(parsed.servers[1]!.enabled).toBe(false);
  });

  it("hook mapping produces correct summary and servers shape", () => {
    // Simulate the mapping done inside useMcpServers queryFn
    const full = McpServersFullResponse.parse({
      servers: [
        { name: "a", transport: "http", url: "https://a.example", enabled: true, args: [], env: {} },
        { name: "b", transport: "stdio", command: "mcp-b", enabled: false, args: [], env: {} },
        { name: "c", transport: "http", url: "https://c.example", enabled: true, args: [], env: {} },
      ],
    });

    const summary = summarizeMcpServers(full);

    expect(summary).toEqual({
      summary: { total: 3, enabled: 2 },
      servers: [
        { name: "a", enabled: true },
        { name: "b", enabled: false },
        { name: "c", enabled: true },
      ],
    });
  });

  it("empty server list produces zero summary", () => {
    const full = McpServersFullResponse.parse({ servers: [] });
    expect(summarizeMcpServers(full)).toEqual({ summary: { total: 0, enabled: 0 }, servers: [] });
  });
});
