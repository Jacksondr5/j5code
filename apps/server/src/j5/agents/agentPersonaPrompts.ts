import type { AgentPersonaId } from "@t3tools/contracts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";

/** Legacy assignments keep the original bundled Builder prompt. New assignments use snapshots. */
export const BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1 = BUILT_IN_AGENT_PERSONAS.builder.instructions;

export function getBuiltInAgentPersonaInstructions(input: {
  readonly personaId: AgentPersonaId;
  readonly definitionVersion: number;
}): string | undefined {
  return input.personaId === "builder" && input.definitionVersion === 1
    ? BUILDER_AGENT_PERSONA_INSTRUCTIONS_V1
    : undefined;
}

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
