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

export type SeatStart = "started" | "failed" | "pending";

export interface CrewRosterSeat {
  readonly seat: string;
  readonly participantId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** Joined at the version this notice announces (an approved addition). */
  readonly isNew: boolean;
  /** How this seat's first turn went, for the seats this launch report watched; null otherwise. */
  readonly start: SeatStart | null;
}

/** A seat that failed, with the run's recorded error as the report carried it. */
export interface SeatStartFailure {
  readonly seat: string;
  readonly runStatus: string;
  readonly detail: string;
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
      /** What the person changed against the proposal, as the report words it; null when nothing. */
      readonly changes: string | null;
      readonly failures: ReadonlyArray<SeatStartFailure>;
      /** Seats whose first turn had not started when the report's window closed. */
      readonly pendingSeats: ReadonlyArray<string>;
    };

// The Claude effort prefix (`applyClaudePromptEffortPrefix`) is applied after the wrapper, so a
// launch sent with ultrathink starts with that line; the card skips it rather than showing the
// raw block.
const LAUNCH_BLOCK =
  /^(?:Ultrathink:\n)?<j5_crew_launch>\n([\s\S]*?)\n<\/j5_crew_launch>\n\n([\s\S]*)$/;
const GATE_BLOCK = /^<j5_crew_gate>\n([\s\S]*?)\n<\/j5_crew_gate>/;
const ROSTER_LINE =
  /^- ([^:]+): participant_id=(\S+) agent=(\S+) thread_id=(\S+)(?: start=(started|failed|pending))?( \(new\))?$/;

// Decode after parsing: provider diagnostics cannot create fields or terminate tagged blocks.
const decodeFailureField = (value: string) =>
  value.replace(/&#(10|13|38|60|62|8232|8233);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  );

const field = (block: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? null;
/** Every line of a repeated field, in order: the report has one `seat_failed` line per seat. */
const fields = (block: string, name: string) =>
  [...block.matchAll(new RegExp(`^${name}: (.*)$`, "gm"))].map((match) => match[1]!.trim());
const seatStart = (value: string | undefined): SeatStart | null =>
  value === "started" || value === "failed" || value === "pending" ? value : null;

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
                    isNew: seat[6] !== undefined,
                    start: seatStart(seat[5]),
                  },
                ],
          );
  // `seat_failed: <seat> | <run status> | <error>`; the error may itself contain the separator.
  const failures = fields(block, "seat_failed").flatMap((entry) => {
    const [seat, runStatus, ...rest] = entry.split(" | ");
    return seat === undefined || runStatus === undefined || rest.length === 0
      ? []
      : [{ seat, runStatus, detail: decodeFailureField(rest.join(" | ")) }];
  });
  const changes = field(block, "changes");
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
    changes: changes === null || changes === "none" ? null : changes,
    failures,
    pendingSeats: fields(block, "seat_pending"),
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

/** The card's title: what was decided and, for an approval, whether the launch went whole. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return notice.requestKind === "roster" ? "Crew declined" : "Seat declined";
  if (notice.failures.length > 0)
    return notice.requestKind === "roster"
      ? `Crew launched, ${notice.failures.length} ${notice.failures.length === 1 ? "seat" : "seats"} failed`
      : "Seat failed";
  return notice.requestKind === "roster" ? "Crew launched" : "Seat added";
};

/** The card's last line: what is true of the seats now that the report has been read. */
export const crewGateFooter = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return "The Captain can revise the request and propose again.";
  const parts: Array<string> = [];
  if (notice.failures.length > 0)
    parts.push(
      `${notice.failures.length} ${notice.failures.length === 1 ? "seat" : "seats"} failed; the Captain has each reason.`,
    );
  if (notice.pendingSeats.length > 0)
    parts.push(
      `${notice.pendingSeats.length} ${notice.pendingSeats.length === 1 ? "seat has" : "seats have"} no confirmed provider activity after a minute.`,
    );
  if (parts.length > 0) return parts.join(" ");
  return notice.requestKind === "roster"
    ? "Every seat started with the brief and this roster."
    : "The new seat started with the brief and the current roster.";
};
