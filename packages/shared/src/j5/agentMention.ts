export const PERSONA_MENTION_PREFIX = "@persona:";

/** The text a picker inserts for a chosen persona; the trailing space closes the mention. */
export const agentMentionReplacement = (personaId: string) =>
  `${PERSONA_MENTION_PREFIX}${personaId} `;

export function detectAgentMention(token: string, start: number, end: number) {
  return token.startsWith(PERSONA_MENTION_PREFIX)
    ? {
        kind: "agent" as const,
        query: token.slice(PERSONA_MENTION_PREFIX.length),
        rangeStart: start,
        rangeEnd: end,
      }
    : null;
}
