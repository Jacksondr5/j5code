import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { runOpenCodeSdk } from "../../../provider/opencodeRuntime.ts";
import { j5PreapprovedTools, type J5RuntimePolicy } from "./j5ToolPreapproval.ts";

const T3_MCP_SERVER = "t3-code";
const T3_MCP_KEY_PREFIX = `${T3_MCP_SERVER}_`;

/** OpenCode's MCP name sanitizer; a tool's key is `sanitize(server) + "_" + sanitize(tool)`. */
const sanitizeOpenCodeMcpName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * True when no MCP server other than T3's own can produce a `t3-code_<tool>` key. A server named
 * `t3-code_send` with a tool `message` yields `t3-code_send_message`, so the allows below would
 * wave that tool through without a prompt.
 */
export const j5OpenCodeT3McpKeysAreOurs = (serverNames: Iterable<string>): boolean => {
  for (const name of serverNames) {
    if (name !== T3_MCP_SERVER && sanitizeOpenCodeMcpName(name).startsWith(T3_MCP_KEY_PREFIX)) {
      return false;
    }
  }
  return true;
};

/**
 * Whether the J5 allows may be installed on this session. `t3McpInjected` is the adapter's own
 * condition for adding the t3-code server (never true on an external OpenCode server), and every
 * other configured server must be unable to collide with its tool keys. Fails closed unless
 * OpenCode reports its MCP servers with T3's own connected.
 */
export const j5OpenCodeAllowsT3McpTools = (
  client: OpencodeClient,
  t3McpInjected: boolean,
): Effect.Effect<boolean> =>
  t3McpInjected
    ? runOpenCodeSdk("mcp.status", () => client.mcp.status()).pipe(
        // The SDK resolves HTTP errors as `{ data: undefined, error }` instead of rejecting.
        Effect.map(
          ({ data, error }) =>
            error === undefined &&
            typeof data === "object" &&
            data !== null &&
            data[T3_MCP_SERVER]?.status === "connected" &&
            j5OpenCodeT3McpKeysAreOurs(Object.keys(data)),
        ),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);

/**
 * OpenCode permission rules that let the shared J5 set through without a native prompt or a
 * refusal. OpenCode names an MCP tool `<server>_<tool>` and checks it as its own permission, and
 * the adapter's policy seeds `* deny` then `* ask`, so an unapproved `propose_crew` is asked for in
 * interactive modes and denied under a read-only `never` policy. Rules match last-wins, so the
 * adapter appends these at the very end; worktree handoff, preview, and scheduling keep the
 * adapter's verdict. Returns nothing unless `j5OpenCodeAllowsT3McpTools` held for the session.
 */
export const j5OpenCodePermissionRules = (
  runtimePolicy: J5RuntimePolicy,
  t3McpToolsAllowed: boolean,
): PermissionRuleset =>
  t3McpToolsAllowed
    ? j5PreapprovedTools(runtimePolicy).map((name) => ({
        permission: `${T3_MCP_KEY_PREFIX}${name}`,
        pattern: "*",
        action: "allow" as const,
      }))
    : [];
