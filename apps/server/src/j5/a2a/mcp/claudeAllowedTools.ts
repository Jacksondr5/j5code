import { J5_PREAPPROVED_TOOLS, j5T3McpToolName } from "./j5ToolPreapproval.ts";

/**
 * Tool names Claude pre-approves in a read-only sandbox: the shared J5 set (see
 * j5ToolPreapproval.ts; upstream's read-only list already carries the artifact reads). Claude runs
 * read-only personas in `dontAsk` mode, which silently denies any tool outside the allowlist, so
 * without this spread a read-only Captain or reviewer on Claude could not message, propose, or
 * request anything. The J5 handlers enforce persona permissions themselves; the sandbox guards the
 * workspace, not the coordination surface. tools.test.ts checks it against J5Toolkit.
 */
export const J5_CLAUDE_MCP_ALLOWED_TOOLS: ReadonlyArray<string> =
  J5_PREAPPROVED_TOOLS.map(j5T3McpToolName);
