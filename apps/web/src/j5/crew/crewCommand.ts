import type { OrchestrationV2AgentPersonaRequest } from "@t3tools/contracts";

/**
 * `/crew <brief>` on a fresh thread launches that thread as a Crew Captain: the saved agent with
 * this id is assigned at creation and the brief becomes its first turn. The Captain then lists
 * agents, proposes a roster, and waits for the human gate. The id is a library convention; the
 * user's agent repository supplies the definition.
 */
export const CREW_CAPTAIN_PERSONA_ID = "crew-captain";

export const CREW_CAPTAIN_PERSONA: OrchestrationV2AgentPersonaRequest = {
  personaId: CREW_CAPTAIN_PERSONA_ID,
};

const CREW_COMMAND = /^\/crew(?:\s+([\s\S]+))?$/;

export type CrewCommand =
  | { readonly kind: "launch"; readonly brief: string }
  | { readonly kind: "missing-brief" };

/** Recognize the crew command anywhere a composer text is about to be sent; null means not a command. */
export function parseCrewCommand(text: string): CrewCommand | null {
  const match = CREW_COMMAND.exec(text.trim());
  if (match === null) return null;
  const brief = match[1]?.trim() ?? "";
  return brief.length === 0 ? { kind: "missing-brief" } : { kind: "launch", brief };
}

/** The user-facing reason a crew command cannot run here; null when it can. */
export function crewCommandRefusal(
  command: CrewCommand,
  context: {
    readonly isLocalDraftThread: boolean;
    /** Whether the library has an enabled `crew-captain`; null while unknown (the server decides). */
    readonly captainAvailable: boolean | null;
  },
): { readonly title: string; readonly description: string } | null {
  if (command.kind === "missing-brief")
    return {
      title: "Give the crew a brief",
      description: "Type /crew followed by what the crew should accomplish.",
    };
  if (!context.isLocalDraftThread)
    return {
      title: "Start a new thread for a crew",
      description:
        "/crew launches a Crew Captain as a fresh thread. Open a new thread and send the command there.",
    };
  if (context.captainAvailable === false)
    return {
      title: "Add a crew-captain agent first",
      description: `No enabled saved agent has the id ${CREW_CAPTAIN_PERSONA_ID}. Add one under Settings → Agents, then send /crew again.`,
    };
  return null;
}
