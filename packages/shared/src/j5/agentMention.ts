export const AGENT_MENTION_PREFIX = "@agent:";

/** The text a picker inserts for a chosen agent; the trailing space closes the mention. */
export const agentMentionReplacement = (personaId: string) =>
  `${AGENT_MENTION_PREFIX}${personaId} `;

export function detectAgentMention(token: string, start: number, end: number) {
  return token.startsWith(AGENT_MENTION_PREFIX)
    ? {
        kind: "agent" as const,
        query: token.slice(AGENT_MENTION_PREFIX.length),
        rangeStart: start,
        rangeEnd: end,
      }
    : null;
}
