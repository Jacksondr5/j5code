/**
 * `/crew <brief>` asks the agent in the current thread to compose a Crew for the brief instead of
 * doing the work itself. The thread keeps whatever agent, model, and policy it already runs as; the
 * platform's crew-composition guidance rides along with the brief as that turn's text, so no saved
 * agent is required and the same thread can command more than one Crew.
 */
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

/** The user-facing reason a crew command cannot run; null when it can. */
export function crewCommandRefusal(
  command: CrewCommand,
): { readonly title: string; readonly description: string } | null {
  if (command.kind === "missing-brief")
    return {
      title: "Give the crew a brief",
      description: "Type /crew followed by what the crew should accomplish.",
    };
  return null;
}

/**
 * The turn `/crew` sends: the platform's guidance for composing a Crew, then the brief verbatim.
 * The guidance covers only what the propose_crew tool cannot say about this moment — compose
 * rather than work, end the turn after proposing, and that several Crews may run at once. The
 * roster, the gate, and every later verb are described by the tools themselves.
 */
export const crewLaunchPrompt = (brief: string) =>
  [
    "<j5_crew_launch>",
    "Compose a Crew for the brief below with propose_crew instead of doing the work yourself, then end your turn: the person's decision, and later every seat's finish, arrive as new messages in this thread, so never wait or poll for them inside a turn.",
    "</j5_crew_launch>",
    "",
    brief,
  ].join("\n");
