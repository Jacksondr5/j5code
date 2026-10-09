import {
  J5_COORDINATION_TOOLS,
  J5_PREAPPROVED_TOOLS,
  j5PreapprovedTools,
  type J5RuntimePolicy,
} from "./j5ToolPreapproval.ts";

/** Codex `mcp_servers.<id>.tools.<tool>.approval_mode`, never a server-wide default. */
const preapprovedToolConfig = (names: ReadonlyArray<string>) => ({
  tools: Object.fromEntries(names.map((name) => [name, { approval_mode: "approve" as const }])),
});

export const J5_CODEX_T3_MCP_SERVER_CONFIG = preapprovedToolConfig(J5_PREAPPROVED_TOOLS);
export const J5_CODEX_COORDINATION_MCP_SERVER_CONFIG = preapprovedToolConfig(J5_COORDINATION_TOOLS);

/** Spread into the injected `mcp_servers["t3-code"]` entry; the list is `j5PreapprovedTools`. */
export const j5CodexT3McpServerConfig = (
  runtimePolicy: J5RuntimePolicy | undefined,
): typeof J5_CODEX_T3_MCP_SERVER_CONFIG => preapprovedToolConfig(j5PreapprovedTools(runtimePolicy));
