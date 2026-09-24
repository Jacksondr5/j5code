/**
 * Tool names Claude pre-approves in a read-only sandbox: every J5 verb plus `write_artifact`
 * (upstream's read-only list already carries the artifact reads). Claude runs read-only personas in `dontAsk` mode, which silently denies any tool outside
 * the allowlist, so without this spread a read-only Captain or reviewer on Claude could not
 * message, propose, or request anything. The J5 handlers enforce persona permissions themselves;
 * the sandbox guards the workspace, not the coordination surface. `write_artifact` is here on
 * purpose: a saved agent's declared handoff is a file the agent itself writes into application
 * storage (never the workspace), and a Critic seat that cannot write its ReviewHandoff has no
 * way to finish. Kept as a leaf module (no toolkit import) so the adapter avoids a cycle;
 * tools.test.ts checks it against J5Toolkit.
 */
export const J5_CLAUDE_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = [
  "mcp__t3-code__send_message",
  "mcp__t3-code__list_participants",
  "mcp__t3-code__list_squadrons",
  "mcp__t3-code__join_squadron",
  "mcp__t3-code__spawn_agent",
  "mcp__t3-code__list_personas",
  "mcp__t3-code__propose_crew",
  "mcp__t3-code__request_crew_member",
  "mcp__t3-code__write_artifact", // project artifact toolkit: declared handoffs
  // Provider-native Subagents: a refused Crew member's own helpers (see codexToolApproval.ts).
  "mcp__t3-code__delegate_task",
  "mcp__t3-code__task_status",
  "mcp__t3-code__task_cancel",
  "mcp__t3-code__stop_agent",
  "mcp__t3-code__stop_crew",
  "mcp__t3-code__archive_crew",
  "mcp__t3-code__clear_own_ask",
];
