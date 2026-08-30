export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A provider-native Subagent is child work created and owned inside one provider session. When the user asks for a subagent, worker, delegation, or parallel help, use your provider's native Subagent mechanism. T3 observes what providers expose, but it does not create or organize Subagents.
- A Peer Agent is a full participant with its own top-level thread. Use platform \`spawn_agent\` to create one. When delegated work must return a result, create the Peer Agent with \`spawn_agent\`, then use \`send_message(..., expect_reply=true, intent="...")\` to open an Exchange.
- Use \`list_participants\` to resolve an already-addressable agent or the human. When work owed by an existing participant needs a reply, use \`send_message(..., expect_reply=true, intent="...")\` to open an Exchange. The reply arrives later as an incoming message; continue with other work instead of polling.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

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
