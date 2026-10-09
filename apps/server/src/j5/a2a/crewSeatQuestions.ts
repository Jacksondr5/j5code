import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * Crew seats do not get native question tools (issue #325, Jackson's 2026-09-26 decision). A seat
 * runs out of the person's view, so a question it raises in its own thread waits unseen. A seat
 * that needs a decision asks its Captain with `send_message`; the Captain answers, or asks the
 * person with its own question tool, inline in the Captain thread the person watches. Captains
 * and every other thread keep their native question tools.
 *
 * The runtime policy carries `crewSeat` (resolved in `crewSeatRuntime.ts`); the adapters spread
 * these helpers where they already build their native options. Kept as a leaf module so the
 * adapters import no Crew store code.
 */

/** Appended to a seat's standing instructions, after any provider text that says to ask the user. */
export const CREW_SEAT_QUESTION_INSTRUCTIONS = `## Crew seat: questions go to your Captain

You hold a seat in a Crew, and the person does not watch this thread. When you need a decision, a clarification, or an approval, ask your Captain with \`send_message\` (\`expect_reply=true\`, with an \`intent\`), using the captain_participant_id from your crew context, then continue any work that does not depend on the answer. Your Captain answers, or asks the person. Never ask the person directly: do not end a turn on a question for the user and do not use a native question tool. This replaces any earlier instruction to ask the user directly.`;

type CrewSeatPolicy = Pick<ProviderAdapterV2RuntimePolicy, "crewSeat"> | undefined;

const isCrewSeat = (policy: CrewSeatPolicy) => policy?.crewSeat === true;

/** Claude's native question tool; the SDK removes a disallowed tool from the model's context. */
export const J5_CLAUDE_CREW_SEAT_DISALLOWED_TOOLS: ReadonlyArray<string> = ["AskUserQuestion"];

/** Spread into `makeClaudeQueryOptions` input: `disallowedTools` for a seat, nothing otherwise. */
export const j5ClaudeCrewSeatQueryOverrides = (
  policy: CrewSeatPolicy,
): { readonly disallowedTools?: ReadonlyArray<string> } =>
  isCrewSeat(policy) ? { disallowedTools: J5_CLAUDE_CREW_SEAT_DISALLOWED_TOOLS } : {};

/**
 * Codex's `request_user_input` switches, as dotted session overrides (the same shape as
 * `codex -c key=value`), so neither replaces the user's own `[features]` or `[tools]` tables.
 * `features.default_mode_request_user_input` offers the tool in Default mode;
 * `tools.experimental_request_user_input.enabled` is the tool's own switch. Both are booleans in
 * Codex 0.155's config schema (a non-boolean value fails config load).
 */
export const J5_CODEX_CREW_SEAT_CONFIG = {
  "features.default_mode_request_user_input": false,
  "tools.experimental_request_user_input.enabled": false,
} as const;

/** Spread into the Codex thread `config`: the question-tool switches for a seat, nothing otherwise. */
export const j5CodexCrewSeatConfig = (
  policy: CrewSeatPolicy,
): Partial<typeof J5_CODEX_CREW_SEAT_CONFIG> =>
  isCrewSeat(policy) ? J5_CODEX_CREW_SEAT_CONFIG : {};
