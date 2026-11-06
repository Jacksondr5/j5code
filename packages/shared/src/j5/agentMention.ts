import { detectPlaybookMention } from "./playbookMention.ts";

export { PLAYBOOK_MENTION_PREFIX, playbookMentionReplacement } from "./playbookMention.ts";

const PERSONA_MENTION_PREFIX = "@persona:";

/** The text a picker inserts for a chosen persona; the trailing space closes the mention. */
export const agentMentionReplacement = (personaId: string) =>
  `${PERSONA_MENTION_PREFIX}${personaId} `;

/**
 * The J5 token-level hook both composer trigger detectors call before bare-`@` file search. It
 * serves `@persona:` and `@playbook:`; the playbook mention rides the `"slash-playbook"` kind.
 */
export function detectAgentMention(token: string, start: number, end: number) {
  return (
    detectPlaybookMention(token, start, end) ??
    (token.startsWith(PERSONA_MENTION_PREFIX)
      ? {
          kind: "agent" as const,
          query: token.slice(PERSONA_MENTION_PREFIX.length),
          rangeStart: start,
          rangeEnd: end,
        }
      : null)
  );
}

// Code, `>` quotes and quoted text name a persona without asking for it. A single quote opens a
// quote only where a word can't end before it, so apostrophes ("don't", "Bryant's") stay prose.
const QUOTED_TEXT =
  /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|"[^"\n]*"|\u201c[^\u201d\n]*\u201d|(?<=^|[\s([{])(?:'[^'\n]*'|\u2018[^\u2019\n]*\u2019)(?=$|[\s.,;:!?)\]}])/gmu;
// Opening punctuation may precede a mention; a letter or digit (an email, an identifier) may not.
const PERSONA_MENTION = /(?<=^|[\s([{])@persona:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9-])/gu;

/** Persona ids a message asks for with an unquoted `@persona:ID`, in order, without repeats. */
export function mentionedPersonaIds(text: string): ReadonlyArray<string> {
  const unquoted = text.replace(QUOTED_TEXT, " ");
  return [...new Set(Array.from(unquoted.matchAll(PERSONA_MENTION), (match) => match[1]!))];
}

/** An unquoted `@persona:` or `@playbook:` token is a mention, never a file chip. */
export const isJ5MentionPath = (path: string) =>
  path.startsWith("persona:") || path.startsWith("playbook:");
