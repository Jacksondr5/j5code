export const PLAYBOOK_MENTION_PREFIX = "@playbook:";

/** The text a picker inserts for a chosen playbook; the trailing space closes the mention. */
export const playbookMentionReplacement = (name: string) => `${PLAYBOOK_MENTION_PREFIX}${name} `;

/**
 * Claims every token that starts with `@playbook:` so it never becomes a file search. The query
 * drops trailing punctuation, as `/playbook` does, so `@playbook:review,` still names `review`.
 * It shares #314's `"slash-playbook"` kind; callers tell the two forms apart by the text at
 * `rangeStart`.
 */
export function detectPlaybookMention(token: string, start: number, end: number) {
  return token.startsWith(PLAYBOOK_MENTION_PREFIX)
    ? {
        kind: "slash-playbook" as const,
        query: token.slice(PLAYBOOK_MENTION_PREFIX.length).replace(/[,.;:!?)]+$/, ""),
        rangeStart: start,
        rangeEnd: end,
      }
    : null;
}
