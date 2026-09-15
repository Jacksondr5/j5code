import type { ProviderAdapterV2RuntimePolicy } from "../../../orchestration-v2/ProviderAdapter.ts";

/**
 * t3-code MCP tools pre-approved for every Codex thread running under approval policy "never".
 * Codex 0.153+ refuses any MCP tool that is not annotated read-only under that policy ("MCP tool
 * call requires approval, but approval policy is never"); every saved-agent runtime policy sends
 * "never", and so does an ordinary full-access thread, so this is not persona-specific. `write_artifact`
 * is annotated destructive but writes only to server application storage, never the sandboxed
 * workspace, so pre-approving it keeps the workspace boundary intact while letting a saved agent
 * deliver its handoff. This is the per-tool form (`mcp_servers.<id>.tools.<tool>.approval_mode`),
 * not `default_tools_approval_mode`, which would also wave through worktree handoff, browser
 * preview, and scheduling.
 */
export const J5_CODEX_PREAPPROVED_TOOLS: ReadonlyArray<string> = ["write_artifact"];

export const J5_CODEX_T3_MCP_SERVER_CONFIG = {
  tools: Object.fromEntries(
    J5_CODEX_PREAPPROVED_TOOLS.map((name) => [name, { approval_mode: "approve" as const }]),
  ),
};

/** True when Codex will run this turn with approval policy "never" (explicitly, or by default in full access). */
export const codexApprovalPolicyIsNever = (
  runtimePolicy: ProviderAdapterV2RuntimePolicy | undefined,
): boolean =>
  runtimePolicy !== undefined &&
  (runtimePolicy.approvalPolicy === "never" ||
    (runtimePolicy.approvalPolicy === undefined && runtimePolicy.runtimeMode === "full-access"));

/** Spread into the injected `mcp_servers["t3-code"]` entry; empty unless approvals are off. */
export const j5CodexT3McpServerConfig = (
  runtimePolicy: ProviderAdapterV2RuntimePolicy | undefined,
): typeof J5_CODEX_T3_MCP_SERVER_CONFIG | Record<never, never> =>
  codexApprovalPolicyIsNever(runtimePolicy) ? J5_CODEX_T3_MCP_SERVER_CONFIG : {};
