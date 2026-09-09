export const AGENT_MENTION_PREFIX = "@agent:";

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
