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
