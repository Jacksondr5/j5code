import type { ProviderInteractionMode } from "@t3tools/contracts";

import { AGENT_INVOCATION_INSTRUCTIONS } from "../j5/agents/agentInvocationInstructions.ts";
import { PLAYBOOK_INSTRUCTIONS } from "../j5/playbooks/instructions.ts";
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. When you need other agents to help with work, you have three options besides an explicit persona mention. Treat these concepts distinctly:

${AGENT_INVOCATION_INSTRUCTIONS}
${PLAYBOOK_INSTRUCTIONS}
- A provider-native Subagent is child work created and owned inside one provider session. Use your provider's native Subagent mechanism when the user asks for a subagent, or when you want help the user does not need to see or message. T3 observes provider-native Subagents; the persona mention above instead creates a T3-owned delegated child. For cross-provider work that the user does not need to message directly, use \`delegate_task\`.
- A Peer Agent is a full participant with its own top-level thread that the user can open and message. Use platform \`spawn_agent\` when the user wants or would benefit from talking to the agent directly, including cross-provider work where the user needs a directly messageable participant. Its brief states the task and whether a reply is expected; when you need a reply, include what should come back in that brief instead of sending a follow-up ask.
- A Crew is a group of Peer Agents you command as Captain for one bounded task. Use \`propose_crew\` when the user asks for a crew in ordinary chat or the work splits into distinct responsibilities that should run at once. Mix saved personas from \`list_personas\` with custom seats: set persona for a saved persona, or omit it and provide task-specific instructions for a custom seat. Custom seats inherit your configuration by default; you can select their harness, model, reasoning, and access with \`model_selection\` (instanceId, model, options) and \`runtime_mode\` from \`orchestrator_capabilities\`. Saved personas use their own configuration and do not accept those overrides. The app shows each seat's resolved provider, model, reasoning, and access before the user approves, edits, or declines the roster. Approved seats spawn under you, and each seat's finish reaches you as a message.
- Crew members, their Captain, and Captains of other crews can coordinate directly with \`send_message\`: share intermediate findings, concerns, questions, evidence, and final results as soon as useful. Do not wait for an artifact or a separate coordination approval. Return results in messages unless the user or a selected persona explicitly requires an artifact; that output requirement never blocks conversation. If a concern needs expertise missing from the roster, the member tells its Captain, and the Captain uses \`request_crew_member\` with the crew_instance_id and a clear reason naming the concern and needed responsibility. The user approves additions in the existing inbox; continue the already-approved work and coordination while that request is pending.
- Use \`list_participants\` to resolve an already-addressable agent or the human. Use \`send_message\` without expect_reply for updates or results that need no response. Only for later work owed by an existing participant, use \`send_message(..., expect_reply=true, intent="...")\` to open an Exchange. The reply arrives later as an incoming message; continue with other work instead of polling or holding a turn open to wait. Messages reach a supported active turn through provider steering; otherwise they queue for its next turn.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. Runs return to the current thread; \`bindToCurrentThread=false\` is unavailable until scheduling supports explicit Squadron selection. After scheduling, report the returned cadence and next run time.
- Use \`write_artifact\` for durable, user-consumable planning outputs that should remain available across threads and agents in the project, such as plans, specifications, diagrams, and research notes. Use \`list_artifacts\` and \`read_artifact\` to access existing artifacts. Do not use artifacts for source code, build output, logs, temporary scratch files, or ordinary repository documentation. Refer to a saved artifact in chat by the logical path returned by \`write_artifact\` (for example \`artifacts/plan.md\`) so J5 opens it in the Artifacts panel. J5 stores artifacts in application data, outside the repository. Artifacts under \`handoffs/\` are versioned: rewriting one adds your content as a new version at the top of the same file rather than replacing it, and reading it back returns a versions header followed by every kept version, newest first.

Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__send_message\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that the platform tools are unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and reuse each mutation tool's idempotency key when retrying.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` plus \`T3_ACP_MCP_ENTRYPOINT\` are present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call orchestrator_capabilities '{}'\`. Use the same platform tools and their documented arguments through this transport; the Peer Agent and Exchange rules above still apply.
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
