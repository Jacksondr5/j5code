import type { ProviderAdapterV2RuntimePolicy } from "../../../orchestration-v2/ProviderAdapter.ts";

/**
 * Codex (0.153+) gates every MCP tool that is not annotated read-only behind an approval prompt,
 * and a turn whose approval policy is `never` rejects the call outright with "MCP tool call
 * requires approval, but approval policy is never". Full-access mode and every saved-agent
 * runtime policy send exactly that, so without help `send_message`, `spawn_agent`, and
 * `propose_crew` all fail there. Only the J5 verbs are pre-approved, by name: their handlers
 * authorize each call and their real gates live server-side, plus `write_artifact`, which a saved
 * agent needs for its declared handoff file (application storage, never the workspace), plus the
 * provider-native Subagent verbs (`delegate_task`, `task_status`, `task_cancel`): a Crew member is
 * refused `spawn_agent` and told to run its own helpers as Subagents, so those must work under
 * the same policy, and a child inherits its parent's sandbox through the escalation check. The
 * rest of the t3-code server (worktree handoff, browser preview, scheduling) keeps Codex's own
 * verdict, so a read-only persona under `never` still cannot reach those. Interactive modes
 * pre-approve only routine communication and filing roster requests; the latter still require
 * human approval in the app before any member launches. Lifecycle and spawning tools keep
 * Codex's prompting in those modes. Kept as a leaf module (no toolkit import) so the adapter
 * avoids a cycle; the test checks the full list against J5Toolkit.
 */
export const J5_CODEX_PREAPPROVED_TOOLS: ReadonlyArray<string> = [
  "send_message",
  "list_participants",
  "list_squadrons",
  "join_squadron",
  "spawn_agent",
  "list_personas",
  "propose_crew",
  "request_crew_member",
  // Declared handoffs are files the seat writes itself into application storage.
  "write_artifact",
  // Provider-native Subagents: the one way a Crew member gets more hands.
  "delegate_task",
  "task_status",
  "task_cancel",
  "stop_agent",
  "stop_crew",
  "archive_crew",
  "clear_own_ask",
  "playbook_list",
  "playbook_start",
  "playbook_current",
  "playbook_next",
  "playbook_back",
  "playbook_reselect",
  "playbook_complete",
  "playbook_cancel",
];

/** These calls coordinate approved work or file a request in the app's human approval inbox. */
export const J5_CODEX_COORDINATION_TOOLS: ReadonlyArray<string> = [
  "send_message",
  "clear_own_ask",
  "propose_crew",
  "request_crew_member",
];

/** Codex `mcp_servers.<id>.tools.<tool>.approval_mode`, never a server-wide default. */
const preapprovedToolConfig = (names: ReadonlyArray<string>) => ({
  tools: Object.fromEntries(names.map((name) => [name, { approval_mode: "approve" as const }])),
});

export const J5_CODEX_T3_MCP_SERVER_CONFIG = preapprovedToolConfig(J5_CODEX_PREAPPROVED_TOOLS);
export const J5_CODEX_COORDINATION_MCP_SERVER_CONFIG = preapprovedToolConfig(
  J5_CODEX_COORDINATION_TOOLS,
);

/** Mirrors the adapter's runtime-mode default: only full-access resolves to `never` on its own. */
export const codexApprovalPolicyIsNever = (
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "approvalPolicy"> | undefined,
): boolean =>
  runtimePolicy !== undefined &&
  (runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "full-access"
    : runtimePolicy.approvalPolicy === "never");

export const j5CodexT3McpServerConfig = (
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "approvalPolicy"> | undefined,
): typeof J5_CODEX_T3_MCP_SERVER_CONFIG =>
  codexApprovalPolicyIsNever(runtimePolicy)
    ? J5_CODEX_T3_MCP_SERVER_CONFIG
    : J5_CODEX_COORDINATION_MCP_SERVER_CONFIG;
