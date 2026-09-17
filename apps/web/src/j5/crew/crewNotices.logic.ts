/**
 * The platform's Crew notices as they appear in a Captain's thread, recognized from their tags so
 * the timeline can show a card instead of the raw block. Recognition is strict: a block the
 * parser does not understand stays raw, and prose is never guessed at.
 */
export interface CrewNoticeMessage {
  readonly role: string;
  readonly text: string;
  readonly createdBy?: string | undefined;
}

export interface CrewRosterSeat {
  readonly seat: string;
  readonly participantId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** Joined at the version this notice announces (an approved addition). */
  readonly isNew: boolean;
}

export type CrewNoticePresentation =
  | {
      /** The person's `/crew <brief>` turn: the brief, with the guidance block set aside. */
      readonly kind: "launch";
      readonly brief: string;
      readonly guidance: string;
    }
  | {
      /** The gate's decision, posted to the Captain by the platform. */
      readonly kind: "gate";
      readonly proposalId: string;
      readonly requestKind: "roster" | "addition";
      readonly decision: "approved" | "declined";
      readonly crewName: string | null;
      readonly crewInstanceId: string | null;
      readonly crewVersion: number | null;
      readonly roster: ReadonlyArray<CrewRosterSeat>;
      readonly requestedSeats: ReadonlyArray<{ readonly seat: string; readonly agentId: string }>;
    };

// The Claude effort prefix (`applyClaudePromptEffortPrefix`) is applied after the wrapper, so a
// launch sent with ultrathink starts with that line; the card skips it rather than showing the
// raw block.
const LAUNCH_BLOCK =
  /^(?:Ultrathink:\n)?<j5_crew_launch>\n([\s\S]*?)\n<\/j5_crew_launch>\n\n([\s\S]*)$/;
const GATE_BLOCK = /^<j5_crew_gate>\n([\s\S]*?)\n<\/j5_crew_gate>/;
const ROSTER_LINE = /^- ([^:]+): participant_id=(\S+) agent=(\S+) thread_id=(\S+)( \(new\))?$/;

const field = (block: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? null;

const parseLaunch = (text: string): CrewNoticePresentation | null => {
  const match = LAUNCH_BLOCK.exec(text);
  if (match === null) return null;
  const brief = match[2]!.trim();
  return brief.length === 0 ? null : { kind: "launch", guidance: match[1]!.trim(), brief };
};

const parseGate = (text: string): CrewNoticePresentation | null => {
  const match = GATE_BLOCK.exec(text);
  if (match === null) return null;
  const block = match[1]!;
  const proposalId = field(block, "proposal_id");
  const requestKind = field(block, "kind");
  const decision = field(block, "decision");
  if (
    proposalId === null ||
    (requestKind !== "roster" && requestKind !== "addition") ||
    (decision !== "approved" && decision !== "declined")
  )
    return null;
  const rosterStart = block.indexOf("\nroster:\n");
  const roster =
    rosterStart === -1
      ? []
      : block
          .slice(rosterStart + "\nroster:\n".length)
          .split("\n")
          .map((line) => ROSTER_LINE.exec(line.trim()))
          .flatMap((seat) =>
            seat === null
              ? []
              : [
                  {
                    seat: seat[1]!,
                    participantId: seat[2]!,
                    agentId: seat[3]!,
                    threadId: seat[4]!,
                    isNew: seat[5] !== undefined,
                  },
                ],
          );
  const requestedSeats = (field(block, "requested_seats") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      return separator <= 0
        ? []
        : [{ seat: entry.slice(0, separator), agentId: entry.slice(separator + 1) }];
    });
  const version = field(block, "crew_version");
  return {
    kind: "gate",
    proposalId,
    requestKind,
    decision,
    crewName: field(block, "crew_name"),
    crewInstanceId: field(block, "crew_instance_id"),
    crewVersion: version === null || !/^\d+$/.test(version) ? null : Number(version),
    roster,
    requestedSeats,
  };
};

/** Null for anything that is not a Crew notice; the ordinary renderer then owns the message. */
export const presentCrewNotice = (message: CrewNoticeMessage): CrewNoticePresentation | null => {
  if (message.role !== "user") return null;
  if (message.createdBy === "system") return parseGate(message.text);
  if (message.createdBy === undefined || message.createdBy === "user")
    return parseLaunch(message.text);
  return null;
};

/** The seats a gate card names, so the timeline can resolve their labels in its one identity read. */
export const participantIdsForCrewNotice = (message: CrewNoticeMessage): ReadonlyArray<string> => {
  const notice = presentCrewNotice(message);
  return notice?.kind === "gate" ? notice.roster.map((seat) => seat.participantId) : [];
};

/** The card's title: what was decided, about what. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) =>
  notice.decision === "approved"
    ? notice.requestKind === "roster"
      ? "Crew approved"
      : "Seat added"
    : notice.requestKind === "roster"
      ? "Crew declined"
      : "Seat declined";
