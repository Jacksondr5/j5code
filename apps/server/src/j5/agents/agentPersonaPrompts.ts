/**
 * Adapter-side composition helpers. Upstream adapters call exactly one of these where they
 * already build developer or system instructions, so persona prompt plumbing stays here.
 */
export const withAgentPersonaInstructions = (
  base: string | undefined,
  persona: string | undefined,
): string | undefined =>
  persona === undefined ? base : base === undefined ? persona : `${base}\n\n${persona}`;

export const agentPersonaPromptSuffix = (persona: string | undefined): string =>
  persona === undefined ? "" : `\n\n${persona}`;
