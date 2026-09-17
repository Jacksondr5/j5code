export const PERSONA_MENTION_PREFIX = "@persona:";
/** The pre-rename spelling (2026-09-17); still recognized so existing habits and saved drafts keep working. */
export const LEGACY_AGENT_MENTION_PREFIX = "@agent:";
/** @deprecated Use PERSONA_MENTION_PREFIX; kept so older call sites compile. */
export const AGENT_MENTION_PREFIX = PERSONA_MENTION_PREFIX;

/** The text a picker inserts for a chosen persona; the trailing space closes the mention. */
export const agentMentionReplacement = (personaId: string) =>
  `${PERSONA_MENTION_PREFIX}${personaId} `;

export function detectAgentMention(token: string, start: number, end: number) {
  const prefix = token.startsWith(PERSONA_MENTION_PREFIX)
    ? PERSONA_MENTION_PREFIX
    : token.startsWith(LEGACY_AGENT_MENTION_PREFIX)
      ? LEGACY_AGENT_MENTION_PREFIX
      : null;
  return prefix === null
    ? null
    : {
        kind: "agent" as const,
        query: token.slice(prefix.length),
        rangeStart: start,
        rangeEnd: end,
      };
}
