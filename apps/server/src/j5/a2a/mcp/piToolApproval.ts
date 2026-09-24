import { j5PreapprovedTools, j5T3McpToolName, type J5RuntimePolicy } from "./j5ToolPreapproval.ts";

/** Comma-separated `mcp__t3-code__<tool>` names the injected Pi extension lets through unasked. */
export const J5_PI_PREAPPROVED_TOOLS_ENV = "T3_J5_PREAPPROVED_TOOLS";
/** The `--extension` path of T3's bridge, which Pi stamps on each tool the bridge registers. */
export const J5_PI_EXTENSION_PATH_ENV = "T3_J5_PI_EXTENSION_PATH";

/**
 * Pi leaves permission policy to extensions, and T3's injected bridge asks before every tool that
 * is not a read in any mode short of full-access, so an unapproved `propose_crew` raised Pi's own
 * confirm ahead of the roster gate. The adapter spreads this into the Pi process environment. Both
 * values are empty unless the launch carries T3 MCP credentials, and both keys are always set so a
 * value inherited from a parent process never widens this session.
 */
export const j5PiPreapprovalEnv = (
  runtimePolicy: J5RuntimePolicy,
  hasT3McpCredentials: boolean,
  extensionPath: string,
): Record<typeof J5_PI_PREAPPROVED_TOOLS_ENV | typeof J5_PI_EXTENSION_PATH_ENV, string> => ({
  [J5_PI_PREAPPROVED_TOOLS_ENV]: hasT3McpCredentials
    ? j5PreapprovedTools(runtimePolicy).map(j5T3McpToolName).join(",")
    : "",
  [J5_PI_EXTENSION_PATH_ENV]: hasT3McpCredentials ? extensionPath : "",
});

/**
 * Extension source interpolated as the first statement of T3's Pi extension, where `pi` and `env`
 * are in scope. It defines `j5Preapproved(toolName)` for the `tool_call` hook.
 *
 * Pi extensions can register a tool under any name, and Pi keeps the first registration of a name,
 * so a listed name alone proves nothing. The preamble records the `parameters` object of every tool
 * this extension registers (only the bridge does, after its authenticated `tools/list`) and skips
 * the confirm only when `pi.getAllTools()` resolves the name to that same object and its
 * `sourceInfo.path` is the bridge's own `--extension` path. Anything it cannot verify, including a
 * Pi without `getAllTools`, is still confirmed.
 */
export const J5_PI_PREAPPROVAL_SOURCE = `\
  const j5PreapprovedNames = new Set(
    (env(${JSON.stringify(J5_PI_PREAPPROVED_TOOLS_ENV)}) ?? "")
      .split(",")
      .filter((name) => name.startsWith("mcp__t3-code__")),
  );
  const j5OwnPath = env(${JSON.stringify(J5_PI_EXTENSION_PATH_ENV)});
  const { resolve: j5ResolvePath } = await import("node:path");
  const j5OwnParameters = new Map<string, unknown>();
  try {
    const j5RegisterTool = pi.registerTool.bind(pi);
    pi.registerTool = ((tool: Parameters<typeof pi.registerTool>[0]) => {
      j5RegisterTool(tool);
      j5OwnParameters.set(tool.name, tool.parameters);
    }) as typeof pi.registerTool;
  } catch {
    // A Pi whose API cannot be wrapped records nothing, so nothing is skipped.
  }
  const j5Preapproved = (toolName: string): boolean => {
    if (j5OwnPath === undefined || typeof pi.getAllTools !== "function") return false;
    if (!j5PreapprovedNames.has(toolName) || !j5OwnParameters.has(toolName)) return false;
    try {
      const resolved = pi.getAllTools().find((tool) => tool.name === toolName);
      return (
        resolved !== undefined &&
        resolved.parameters === j5OwnParameters.get(toolName) &&
        j5ResolvePath(resolved.sourceInfo.path) === j5ResolvePath(j5OwnPath)
      );
    } catch {
      return false;
    }
  };
`;
