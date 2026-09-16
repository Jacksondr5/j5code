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
    "Compose a Crew for the brief below instead of doing the work yourself. Read the brief and anything it references, call list_agents, and choose the smallest roster that covers the work, one seat per distinct responsibility. File it with propose_crew: a short crew name that says what this Crew is for, the brief every seat starts on, and one seat per agent with a one-line reason and, when useful, seat instructions. Then end your turn; the person's decision, and later every seat's finish, arrive as new messages in this thread, so never wait or poll for them inside a turn. Approved seats run with their own agent's permissions, and propose_crew is itself the human gate, so a read-only session or an approval policy of never does not block it. You may command several Crews at once when the work is concurrent; each proposal names its own Crew, and later requests, stops, and archives name the Crew they mean.",
    "</j5_crew_launch>",
    "",
    brief,
  ].join("\n");
