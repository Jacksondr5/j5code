import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpToolCallState } from "../../../provider/acp/AcpRuntimeModel.ts";
import { type J5RuntimePolicy, j5PreapprovedTools } from "./j5ToolPreapproval.ts";

/**
 * Pre-approves J5 tools on ACP agents, whose MCP calls otherwise reach `acpPermissionDisposition`
 * as ordinary unclassified tools (a native prompt in approval-required, a denial for persona
 * seats). ACP has no typed MCP call, so identity is recovered only from fields a harness fills
 * from its own MCP dispatch, never from titles, which some harnesses let the model write:
 *   - codex-acp: `_meta.is_mcp_tool_call` with `rawInput.server` / `rawInput.tool` (kind execute);
 *   - qwen-code: `_meta.serverId` with `_meta.toolName` as `mcp::<server>::<tool>` (both required);
 *   - claude-acp: `_meta.claudeCode.toolName` as `mcp__<server>__<tool>`.
 * Identity comes only from the merged `session/update` state the adapter recorded for that
 * toolCallId in the root session; the permission request can only confirm it, and must repeat the
 * recorded kind. Every identity field present (state and request, including goose's extension)
 * must name t3-code and the same tool. Only a one-time `allow_once` option is ever selected.
 * Grok and Antigravity carry none of these fields, so they keep today's verdict. Kept as a leaf
 * module (type-only imports) so the adapter avoids a cycle.
 */

const T3_SERVER = "t3-code";
const MCP_APPROVAL_REQUEST_PREFIX = "mcp_tool_call_approval_";
/** Kinds that act on the machine; never an MCP call, whatever a field claims. */
const MACHINE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

type ClaimSource = "codex-acp" | "qwen" | "claude-acp" | "veto";

interface IdentityClaim {
  readonly server: string;
  readonly tool: string;
  readonly source: ClaimSource;
}

interface ToolCallView {
  readonly kind: string | undefined;
  readonly rawInput: Record<string, unknown> | undefined;
  readonly meta: Record<string, unknown> | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;

const stateView = (state: AcpToolCallState): ToolCallView => ({
  kind: state.kind ?? text(state.data.kind),
  rawInput: record(state.data.rawInput),
  meta: record(state.data.meta),
});

const requestView = (
  toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"],
): ToolCallView => ({
  kind: text(toolCall.kind),
  rawInput: record(toolCall.rawInput),
  meta: record(toolCall._meta),
});

const QWEN_TOOL_NAME = /^mcp::(?<server>[^:]+)::(?<tool>.+)$/;
const CLAUDE_TOOL_NAME = /^mcp__(?<server>.+?)__(?<tool>.+)$/;

/** Claims from recorded state may grant; claims from a request only ever veto. */
function claimsOf(view: ToolCallView, fromState: boolean): Array<IdentityClaim> {
  const claims: Array<IdentityClaim> = [];
  const grant = (source: Exclude<ClaimSource, "veto">): ClaimSource =>
    fromState ? source : "veto";
  const { rawInput, meta } = view;

  const rawServer = text(rawInput?.server);
  const rawTool = text(rawInput?.tool);
  // Only codex-acp's tag makes these fields a grant; untagged, they are still an identity that
  // must agree, so a request naming another tool here vetoes.
  if (rawServer !== undefined || rawTool !== undefined) {
    claims.push({
      server: rawServer ?? "",
      tool: rawTool ?? "",
      source: meta?.is_mcp_tool_call === true ? grant("codex-acp") : "veto",
    });
  }

  const serverId = text(meta?.serverId);
  const metaToolName = text(meta?.toolName);
  if (serverId !== undefined || metaToolName !== undefined) {
    const parsed =
      metaToolName === undefined ? undefined : QWEN_TOOL_NAME.exec(metaToolName)?.groups;
    // qwen grants only through its full `mcp::<server>::<tool>` name alongside a serverId; a bare
    // tool name next to a serverId proves nothing and can only veto.
    if (parsed !== undefined) {
      claims.push({
        server: parsed.server!,
        tool: parsed.tool!,
        source: serverId === undefined ? "veto" : grant("qwen"),
      });
    }
    claims.push({
      server: serverId ?? "",
      tool: parsed?.tool ?? metaToolName ?? "",
      source: "veto",
    });
  }

  const claudeToolName = text(record(meta?.claudeCode)?.toolName);
  if (claudeToolName !== undefined) {
    const parsed = CLAUDE_TOOL_NAME.exec(claudeToolName)?.groups;
    // A non-MCP Claude tool (e.g. "Bash") is a claim too: it vetoes any t3-code identity.
    claims.push(
      parsed === undefined
        ? { server: "", tool: claudeToolName, source: "veto" }
        : { server: parsed.server!, tool: parsed.tool!, source: grant("claude-acp") },
    );
  }

  const goose = record(record(meta?.goose)?.toolCall);
  const gooseExtension = text(goose?.extensionName);
  if (gooseExtension !== undefined) {
    claims.push({ server: gooseExtension, tool: text(goose?.toolName) ?? "", source: "veto" });
  }
  return claims;
}

/**
 * The t3-code tool a call is proven to invoke, or undefined. Requires recorded state; a request,
 * when given, may only confirm it.
 */
export function j5AcpT3ToolName(
  state: AcpToolCallState | undefined,
  request?: EffectAcpSchema.RequestPermissionRequest["toolCall"],
): string | undefined {
  if (state === undefined) return undefined;
  if (request !== undefined && text(request.toolCallId) !== state.toolCallId) return undefined;
  const recorded = stateView(state);
  const asked = request === undefined ? undefined : requestView(request);

  // The recorded kind governs; a request must repeat it, never drop or change it.
  const kind = recorded.kind;
  if (asked !== undefined && (asked.kind === undefined || asked.kind !== kind)) return undefined;
  if (kind !== undefined && MACHINE_KINDS.has(kind)) return undefined;

  const claims = [
    ...claimsOf(recorded, true),
    ...(asked === undefined ? [] : claimsOf(asked, false)),
  ];
  const granting = claims.filter((claim) => claim.source !== "veto");
  if (granting.length === 0) return undefined;
  const tool = claims[0]!.tool;
  if (tool.length === 0) return undefined;
  if (!claims.every((claim) => claim.server === T3_SERVER && claim.tool === tool)) return undefined;
  // codex-acp tags its MCP calls as execute; no other source may approve an execute call.
  if (kind === "execute" && !granting.some((claim) => claim.source === "codex-acp")) {
    return undefined;
  }
  return tool;
}

/**
 * A one-time allow for a proven J5 call from the root session that the policy pre-approves, or
 * undefined to leave the upstream verdict. Never selects `allow_always`: upstream's own allow
 * prefers it, which would turn one approval into a standing one.
 */
export function j5AcpPermissionResponse(
  runtimePolicy: J5RuntimePolicy | undefined,
  request: EffectAcpSchema.RequestPermissionRequest,
  tools: ReadonlyMap<string, AcpToolCallState>,
  rootSessionId: string,
): { readonly outcome: { readonly outcome: "selected"; readonly optionId: string } } | undefined {
  // ToolCallIds are unique only within a session; `tools` holds the root session's calls.
  if (request.sessionId !== rootSessionId) return undefined;
  const tool = j5AcpT3ToolName(tools.get(request.toolCall.toolCallId), request.toolCall);
  if (tool === undefined || !j5PreapprovedTools(runtimePolicy).includes(tool)) return undefined;
  const optionId = request.options.find((option) => option.kind === "allow_once")?.optionId.trim();
  return optionId ? { outcome: { outcome: "selected", optionId } } : undefined;
}

/**
 * codex-acp asks for MCP approval through an elicitation that names no tool; its request id is
 * `mcp_tool_call_approval_<toolCallId>` of the root-session tool_call update that carries the
 * identity. Upstream's allow answer there (`accept` with empty content) is already one-time.
 */
export function j5AcpMcpElicitationDisposition(
  runtimePolicy: J5RuntimePolicy | undefined,
  transportRequestId: string,
  sessionId: string | undefined,
  tools: ReadonlyMap<string, AcpToolCallState>,
  rootSessionId: string,
): "allow" | undefined {
  if (sessionId !== undefined && sessionId !== rootSessionId) return undefined;
  if (!transportRequestId.startsWith(MCP_APPROVAL_REQUEST_PREFIX)) return undefined;
  const tool = j5AcpT3ToolName(
    tools.get(transportRequestId.slice(MCP_APPROVAL_REQUEST_PREFIX.length)),
  );
  return tool !== undefined && j5PreapprovedTools(runtimePolicy).includes(tool)
    ? "allow"
    : undefined;
}
