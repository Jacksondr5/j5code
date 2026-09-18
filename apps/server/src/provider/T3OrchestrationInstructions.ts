import { AGENT_INVOCATION_INSTRUCTIONS } from "../j5/agents/agentInvocationInstructions.ts";
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. When you need other agents to help with work, you have three options besides an explicit saved-agent mention. Treat these concepts distinctly:

${AGENT_INVOCATION_INSTRUCTIONS}
- A provider-native Subagent is child work created and owned inside one provider session. Use your provider's native Subagent mechanism when the user asks for a subagent, or when you want help the user does not need to see or message. T3 observes provider-native Subagents; the saved-agent mention above instead creates a T3-owned delegated child. For cross-provider work that the user does not need to message directly, use \`delegate_task\`.
- A Peer Agent is a full participant with its own top-level thread that the user can open and message. Use platform \`spawn_agent\` when the user wants or would benefit from talking to the agent directly, including cross-provider work where the user needs a directly messageable participant. Its brief states the task and whether a reply is expected; when you need a reply, include what should come back in that brief instead of sending a follow-up ask.
- A Crew is a group of Peer Agents you command for one bounded task; the user can message any seat but mostly speaks through you. Use \`propose_crew\` when the user asks for a crew or the work splits into distinct responsibilities that should run at once: pick seats from \`list_agents\`, and the user approves, edits, or declines the roster in the app. Approved seats spawn under you, and each seat's finish reaches you as a message.
- Use \`list_participants\` to resolve an already-addressable agent or the human. Only for later work owed by an existing participant, use \`send_message(..., expect_reply=true, intent="...")\` to open an Exchange. The reply arrives later as an incoming message; continue with other work instead of polling.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.
- Use \`write_artifact\` for durable, user-consumable planning outputs that should remain available across threads and agents in the project, such as plans, specifications, diagrams, and research notes. Use \`list_artifacts\` and \`read_artifact\` to access existing artifacts. Do not use artifacts for source code, build output, logs, temporary scratch files, or ordinary repository documentation. Refer to a saved artifact in chat by the logical path returned by \`write_artifact\` (for example \`artifacts/plan.md\`) so J5 opens it in the Artifacts panel. J5 stores artifacts in application data, outside the repository. Artifacts under \`handoffs/\` are versioned: rewriting one adds your content as a new version at the top of the same file rather than replacing it, and reading it back returns a versions header followed by every kept version, newest first.

Tool names may include an MCP prefix (for example \`mcp__t3-code__send_message\`); the semantics are the same. Do not duplicate active work, and reuse each mutation tool's idempotency key when retrying.
`;

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
export function prependT3OrchestrationInstructions(prompt: string): string {
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
