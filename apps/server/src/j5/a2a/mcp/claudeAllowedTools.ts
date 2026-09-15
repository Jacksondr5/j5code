/**
 * t3-code MCP tools every read-only Claude thread may call in addition to upstream's read-only list.
 *
 * Claude runs read-only threads with permissionMode `dontAsk`, which silently denies any tool that
 * is not pre-approved. Saved agents must write their declared handoff with `write_artifact`, and
 * the read-only override has no persona knowledge, so this applies to every read-only Claude
 * thread, saved agent or not. Artifacts live in server application storage, never in the sandboxed
 * workspace, so pre-approving it does not widen what the sandbox lets the agent touch. Later J5
 * branches extend this list here rather than in the upstream adapter.
 */
export const J5_CLAUDE_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = ["mcp__t3-code__write_artifact"];
