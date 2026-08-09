import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { McpServersFullResponse, type McpServersResponse, type McpServer } from "@hermes/protocol";

export const MCP_SERVERS_ENDPOINT = "/api/mcp/servers";

export function summarizeMcpServers(full: { servers: readonly Pick<McpServer, "name" | "enabled">[] }): McpServersResponse {
  const servers = full.servers.map((s) => ({ name: s.name, enabled: s.enabled }));
  const total = servers.length;
  const enabled = servers.filter((s) => s.enabled).length;
  return { summary: { total, enabled }, servers };
}

export function useMcpServers() {
  const profile = useActiveProfileName();
  return useQuery<McpServersResponse>({
    queryKey: ["mcp-servers", profile],
    queryFn: async ({ signal }) => {
      const full = await fetchJSON(MCP_SERVERS_ENDPOINT, { signal }, McpServersFullResponse);
      return summarizeMcpServers(full);
    },
    staleTime: 60_000,
  });
}
