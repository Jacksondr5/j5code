import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  type AcpToolCallState,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "../../../provider/acp/AcpRuntimeModel.ts";
import {
  j5AcpMcpElicitationDisposition,
  j5AcpPermissionResponse,
  j5AcpT3ToolName,
} from "./acpToolApproval.ts";
import { type J5RuntimePolicy, j5PreapprovedTools } from "./j5ToolPreapproval.ts";
import {
  J5_APPROVAL_POLICY_MATRIX,
  J5_NEVER_PREAPPROVED_TOOLS,
} from "./j5ToolPreapproval.testkit.ts";

type Update = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { sessionUpdate: "tool_call" }
>;
type RequestToolCall = EffectAcpSchema.RequestPermissionRequest["toolCall"];

const ROOT = "session-1";
const PERSONA: J5RuntimePolicy = { runtimeMode: "approval-required", approvalPolicy: "never" };
const POLICIES = [...J5_APPROVAL_POLICY_MATRIX.map((entry) => entry.policy), PERSONA];
const ALL_OPTIONS: EffectAcpSchema.RequestPermissionRequest["options"] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];
const ALLOW_ONCE = { outcome: { outcome: "selected", optionId: "allow-once" } };

// Built through the adapter's own parse + merge path, as `context.tools` holds it.
function stateFrom(update: Update): AcpToolCallState {
  const parsed = parseSessionUpdateEvent({ sessionId: ROOT, update });
  for (const event of parsed.events)
    if (event._tag === "ToolCallUpdated") return mergeToolCallState(undefined, event.toolCall);
  throw new Error("expected a tool call event");
}

const toolsOf = (state: AcpToolCallState | undefined): Map<string, AcpToolCallState> =>
  state === undefined ? new Map() : new Map([[state.toolCallId, state]]);

const request = (
  toolCall: RequestToolCall,
  options = ALL_OPTIONS,
): EffectAcpSchema.RequestPermissionRequest => ({ sessionId: ROOT, options, toolCall });

const respond = (
  policy: J5RuntimePolicy | undefined,
  req: EffectAcpSchema.RequestPermissionRequest,
  state: AcpToolCallState | undefined,
) => j5AcpPermissionResponse(policy, req, toolsOf(state), ROOT);

const elicit = (
  policy: J5RuntimePolicy | undefined,
  id: string,
  state: AcpToolCallState | undefined,
) => j5AcpMcpElicitationDisposition(policy, id, undefined, toolsOf(state), ROOT);

// codex-acp, shape captured verbatim 2026-08-14 (AcpRuntimeModel.test.ts:1318-1331), tool varied.
const codexUpdate = (tool: string, server = "t3-code"): Update => ({
  sessionUpdate: "tool_call",
  toolCallId: "exec-f4591587-0754-4bb4-990b-f2767894ba93",
  kind: "execute",
  title: `mcp.${server}.${tool}`,
  status: "in_progress",
  rawInput: { server, tool, arguments: {} },
  _meta: { is_mcp_tool_call: true },
});
// qwen-code 0.21.12 shape (AcpRuntimeModel.test.ts:1490-1500), tool varied.
const qwenUpdate = (tool: string, server = "t3-code"): Update => ({
  sessionUpdate: "tool_call",
  toolCallId: "qwen-meta-1",
  kind: "other",
  title: "unrelated display title",
  status: "pending",
  _meta: { toolName: `mcp::${server}::${tool}`, serverId: server, provenance: "mcp" },
});
// claude-acp names MCP tools in `_meta.claudeCode.toolName` (survey, AcpRuntimeModel.ts:1008-1032).
const claudeUpdate = (tool: string): Update => ({
  sessionUpdate: "tool_call",
  toolCallId: "claude-1",
  kind: "other",
  title: tool,
  status: "pending",
  _meta: { claudeCode: { toolName: `mcp__t3-code__${tool}` } },
});
const sparse = (state: AcpToolCallState): RequestToolCall => ({
  toolCallId: state.toolCallId,
  title: "Approve this tool?",
  ...(state.kind === undefined ? {} : { kind: state.kind as EffectAcpSchema.ToolKind }),
});

describe("j5AcpPermissionResponse", () => {
  for (const [label, update] of [
    ["codex-acp", codexUpdate],
    ["qwen", qwenUpdate],
    ["claude-acp", claudeUpdate],
  ] as const) {
    it(`allows exactly the shared set once, per policy, for ${label}`, () => {
      for (const policy of POLICIES)
        for (const tool of ["propose_crew", "send_message", "spawn_agent", "write_artifact"]) {
          const state = stateFrom(update(tool));
          const response = respond(policy, request(sparse(state)), state);
          if (j5PreapprovedTools(policy).includes(tool)) assert.deepEqual(response, ALLOW_ONCE);
          else assert.isUndefined(response);
        }
    });
  }

  it("never selects allow_always, and leaves the verdict when no one-time option exists", () => {
    const state = stateFrom(codexUpdate("propose_crew"));
    const onlyAlways = ALL_OPTIONS.filter((option) => option.kind !== "allow_once");
    for (const policy of POLICIES)
      assert.isUndefined(respond(policy, request(sparse(state), onlyAlways), state));
  });

  it("refuses the reviewer's title-only call with or without recorded state", () => {
    const toolCall: RequestToolCall = {
      toolCallId: "tool-1",
      kind: "other",
      title: "mcp__t3-code__propose_crew",
    };
    const titleOnlyState = stateFrom({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "other",
      title: "mcp__t3-code__propose_crew",
    });
    for (const policy of POLICIES) {
      assert.isUndefined(respond(policy, request(toolCall), undefined));
      assert.isUndefined(respond(policy, request(toolCall), titleOnlyState));
    }
  });

  it("requires recorded state even when the request carries full codex-acp fields", () => {
    const toolCall: RequestToolCall = {
      toolCallId: "exec-1",
      kind: "execute",
      rawInput: { server: "t3-code", tool: "propose_crew" },
      _meta: { is_mcp_tool_call: true },
    };
    for (const policy of POLICIES)
      assert.isUndefined(respond(policy, request(toolCall), undefined));
  });

  it("ignores a child session that reuses a root J5 call id", () => {
    const state = stateFrom(codexUpdate("propose_crew"));
    const child = {
      ...request({ toolCallId: state.toolCallId, kind: "execute" }),
      sessionId: "child-session",
    };
    for (const policy of POLICIES) {
      assert.isUndefined(j5AcpPermissionResponse(policy, child, toolsOf(state), ROOT));
      assert.isUndefined(
        j5AcpMcpElicitationDisposition(
          policy,
          `mcp_tool_call_approval_${state.toolCallId}`,
          "child-session",
          toolsOf(state),
          ROOT,
        ),
      );
    }
    assert.deepEqual(respond(PERSONA, request(sparse(state)), state), ALLOW_ONCE);
  });
});

describe("j5AcpT3ToolName", () => {
  const codex = stateFrom(codexUpdate("propose_crew"));

  it("refuses a qwen serverId next to a bare or unprefixed tool name", () => {
    for (const toolName of ["propose_crew", "t3-code__propose_crew", "mcp::t3-code"])
      assert.isUndefined(
        j5AcpT3ToolName(
          stateFrom({ ...qwenUpdate("propose_crew"), _meta: { toolName, serverId: "t3-code" } }),
        ),
        toolName,
      );
    // The prefixed name without a serverId proves nothing either.
    assert.isUndefined(
      j5AcpT3ToolName(
        stateFrom({
          ...qwenUpdate("propose_crew"),
          _meta: { toolName: "mcp::t3-code::propose_crew" },
        }),
      ),
    );
  });

  it("recovers the tool from each structured form", () => {
    assert.equal(j5AcpT3ToolName(codex, sparse(codex)), "propose_crew");
    assert.equal(j5AcpT3ToolName(stateFrom(qwenUpdate("propose_crew"))), "propose_crew");
    assert.equal(j5AcpT3ToolName(stateFrom(claudeUpdate("propose_crew"))), "propose_crew");
  });

  it("ignores request titles entirely; recorded state decides", () => {
    assert.equal(
      j5AcpT3ToolName(codex, { ...sparse(codex), title: "mcp__t3-code__spawn_agent" }),
      "propose_crew",
    );
  });

  it("refuses a request that contradicts the recorded tool, kind, or call", () => {
    const base = sparse(codex);
    for (const contradiction of [
      {
        ...base,
        rawInput: { server: "t3-code", tool: "send_message" },
        _meta: { is_mcp_tool_call: true },
      },
      { ...base, kind: "other" as const },
      { ...base, toolCallId: "some-other-call" },
    ])
      assert.isUndefined(j5AcpT3ToolName(codex, contradiction));
  });

  it("lets the recorded kind govern: a request cannot drop or change it", () => {
    const edit = stateFrom({ ...codexUpdate("propose_crew"), kind: "edit" });
    for (const toolCall of [
      { toolCallId: edit.toolCallId, kind: "other" as const },
      { toolCallId: edit.toolCallId },
    ])
      assert.isUndefined(j5AcpT3ToolName(edit, toolCall));
    assert.isUndefined(j5AcpT3ToolName(codex, { toolCallId: codex.toolCallId }));
    assert.equal(
      j5AcpT3ToolName(codex, { toolCallId: codex.toolCallId, kind: "execute" }),
      "propose_crew",
    );
  });

  it("refuses the security-reviewer's three bypass shapes", () => {
    assert.isUndefined(
      j5AcpT3ToolName(undefined, {
        toolCallId: "x",
        title: "mcp__t3-code__propose_crew",
        kind: "other",
      }),
    );
    const shell: AcpToolCallState = {
      toolCallId: "x",
      kind: "execute",
      title: "run shell",
      data: { kind: "execute", title: "run shell" },
    };
    assert.isUndefined(
      j5AcpT3ToolName(shell, {
        toolCallId: "x",
        kind: "other",
        title: "mcp__t3-code__propose_crew",
      }),
    );
    const foreign = stateFrom(qwenUpdate("propose_crew", "other"));
    assert.isUndefined(
      j5AcpT3ToolName(foreign, {
        toolCallId: foreign.toolCallId,
        kind: "other",
        _meta: { serverId: "t3-code", toolName: "mcp::t3-code::propose_crew" },
      }),
    );
  });

  it("refuses any foreign server or mismatched tool among the claims", () => {
    for (const update of [
      codexUpdate("propose_crew", "other"),
      qwenUpdate("propose_crew", "other"),
      {
        ...qwenUpdate("propose_crew"),
        _meta: { serverId: "t3-code", toolName: "mcp::other::propose_crew" },
      },
      {
        ...codexUpdate("propose_crew"),
        _meta: { is_mcp_tool_call: true, serverId: "slack", toolName: "propose_crew" },
      },
      {
        ...codexUpdate("other_tool"),
        _meta: { is_mcp_tool_call: true, claudeCode: { toolName: "mcp__t3-code__propose_crew" } },
      },
      { ...claudeUpdate("propose_crew"), _meta: { claudeCode: { toolName: "Bash" } } },
      {
        ...qwenUpdate("propose_crew"),
        _meta: {
          serverId: "t3-code",
          toolName: "mcp::t3-code::propose_crew",
          goose: { toolCall: { extensionName: "slack", toolName: "x" } },
        },
      },
    ] satisfies ReadonlyArray<Update>)
      assert.isUndefined(j5AcpT3ToolName(stateFrom(update)));
  });

  it("allows execute only for the codex-acp tag, and never edit, delete, or move", () => {
    assert.isUndefined(
      j5AcpT3ToolName(stateFrom({ ...qwenUpdate("propose_crew"), kind: "execute" })),
    );
    assert.isUndefined(
      j5AcpT3ToolName(stateFrom({ ...claudeUpdate("propose_crew"), kind: "execute" })),
    );
    for (const kind of ["edit", "delete", "move"] as const)
      assert.isUndefined(j5AcpT3ToolName(stateFrom({ ...codexUpdate("propose_crew"), kind })));
  });

  it("ignores titles, bare names, and the acp-mcp-call fallback", () => {
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "other",
        title: "mcp__t3-code__propose_crew",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "other",
        title: "t3-code___propose_crew",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "other",
        title: "propose_crew (t3-code MCP Server)",
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "other",
        title: "mcp__t3_code__propose_crew",
      },
      { sessionUpdate: "tool_call", toolCallId: "t", kind: "other", title: "t3-code_propose_crew" },
      { sessionUpdate: "tool_call", toolCallId: "t", kind: "other", title: "propose_crew" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "execute",
        title: "rm -rf x; acp-mcp-call propose_crew",
        rawInput: { command: "rm -rf x; acp-mcp-call propose_crew" },
      },
    ] satisfies ReadonlyArray<Update>)
      assert.isUndefined(j5AcpT3ToolName(stateFrom(update)));
  });

  it("never pre-approves t3-code tools outside the J5 set", () => {
    for (const tool of J5_NEVER_PREAPPROVED_TOOLS)
      for (const policy of POLICIES) {
        const state = stateFrom(codexUpdate(tool));
        assert.isUndefined(respond(policy, request(sparse(state)), state));
      }
  });

  // Antigravity shapes restated from AntigravityProtocol.test.ts:25-46 (not exported). The
  // test-engineer adds a Grok case that replays every recorded grok_transcript.ndjson.
  it("matches nothing from Antigravity shapes", () => {
    const shapes: ReadonlyArray<AcpToolCallState> = [
      {
        toolCallId: "trajectory:4",
        kind: "other",
        title: "Run start_subagent?",
        data: { meta: { is_mcp_tool_call: true } },
      },
      {
        toolCallId: "trajectory:5",
        kind: "other",
        title: "Run propose_crew?",
        data: { meta: { is_mcp_tool_call: true } },
      },
      {
        toolCallId: "trajectory:6",
        kind: "other",
        title: "Running propose_crew",
        data: { meta: { is_mcp_tool_call: true } },
      },
    ];
    for (const state of shapes)
      for (const policy of POLICIES) {
        assert.isUndefined(
          respond(
            policy,
            request({
              toolCallId: state.toolCallId,
              ...(state.title === undefined ? {} : { title: state.title }),
              kind: "other",
            }),
            state,
          ),
        );
        assert.isUndefined(elicit(policy, `mcp_tool_call_approval_${state.toolCallId}`, state));
      }
  });
});

describe("j5AcpMcpElicitationDisposition", () => {
  const id = "mcp_tool_call_approval_exec-f4591587-0754-4bb4-990b-f2767894ba93";

  it("allows exactly the shared set through the linked tool call", () => {
    for (const policy of POLICIES)
      for (const tool of ["propose_crew", "spawn_agent"])
        assert.equal(
          elicit(policy, id, stateFrom(codexUpdate(tool))),
          j5PreapprovedTools(policy).includes(tool) ? "allow" : undefined,
        );
  });

  it("leaves the verdict without the request-id link or its recorded call", () => {
    const state = stateFrom(codexUpdate("propose_crew"));
    assert.isUndefined(elicit(PERSONA, "request-7", state));
    assert.isUndefined(elicit(PERSONA, "mcp_tool_call_approval_exec-unknown", state));
  });
});
