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

/** A seat that failed to start, with the run's recorded error as the report carried it. */
export interface SeatStartFailure {
  readonly seat: string;
  readonly runStatus: string;
  readonly detail: string;
}

export type SeatHandoff =
  | { readonly status: "none declared" }
  | {
      readonly status: "written" | "missing";
      readonly kind: string;
      /** The logical path the notice names, `artifacts/handoffs/...`. */
      readonly artifactPath: string | null;
      /** The handoff text when the notice carried it inline. */
      readonly body: string | null;
    };

export interface FinishedSeat {
  readonly seat: string;
  readonly crewName: string | null;
  readonly participantId: string;
  readonly threadId: string;
  readonly runStatus: string;
  readonly handoff: SeatHandoff;
}

export type CrewNoticePresentation =
  | {
      /** One or more seats' finishes, folded into one message when the Captain was mid-turn. */
      readonly kind: "seats";
      readonly seats: ReadonlyArray<FinishedSeat>;
    }
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
      : [{ seat, runStatus, detail: rest.join(" | ") }];
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

const SEAT_OPEN = "<j5_seat_finished>";
const SEAT_BLOCK = /^<j5_seat_finished>\n([\s\S]*?)\n<\/j5_seat_finished>([\s\S]*)$/;
const HANDOFF_BODY = /<handoff_body>\n([\s\S]*?)\n<\/handoff_body>/;
const HANDOFF_FIELD = /^(written|missing) \((.+)\)$/;

const parseSeatSection = (section: string): FinishedSeat | null => {
  const match = SEAT_BLOCK.exec(section);
  if (match === null) return null;
  const block = match[1]!;
  const seat = field(block, "seat");
  const participantId = field(block, "participant_id");
  const threadId = field(block, "thread_id");
  const runStatus = field(block, "run_status");
  const handoffField = field(block, "handoff");
  if (seat === null || participantId === null || threadId === null || runStatus === null)
    return null;
  let handoff: SeatHandoff;
  if (handoffField === null || handoffField === "none declared") {
    handoff = { status: "none declared" };
  } else {
    const parsed = HANDOFF_FIELD.exec(handoffField);
    if (parsed === null) return null;
    const bodyMatch = HANDOFF_BODY.exec(match[2]!);
    handoff = {
      status: parsed[1] as "written" | "missing",
      kind: parsed[2]!,
      artifactPath: field(block, "artifact"),
      body:
        bodyMatch === null
          ? null
          : bodyMatch[1]!
              .replace(/<\\\/handoff_body>/g, "</handoff_body>")
              .replace(/<\\j5_seat_finished>/g, "<j5_seat_finished>"),
    };
  }
  return { seat, crewName: field(block, "crew"), participantId, threadId, runStatus, handoff };
};

const parseSeats = (text: string): CrewNoticePresentation | null => {
  if (!text.startsWith(SEAT_OPEN)) return null;
  const seats = text
    .split(SEAT_OPEN)
    .slice(1)
    .map((part) => parseSeatSection(`${SEAT_OPEN}${part}`.trim()));
  return seats.length === 0 || seats.some((seat) => seat === null)
    ? null
    : { kind: "seats", seats: seats as ReadonlyArray<FinishedSeat> };
};

/** Null for anything that is not a Crew notice; the ordinary renderer then owns the message. */
export const presentCrewNotice = (message: CrewNoticeMessage): CrewNoticePresentation | null => {
  if (message.role !== "user") return null;
  if (message.createdBy === "system") return parseGate(message.text) ?? parseSeats(message.text);
  if (message.createdBy === undefined || message.createdBy === "user")
    return parseLaunch(message.text);
  return null;
};

/** The seats a gate card names, so the timeline can resolve their labels in its one identity read. */
export const participantIdsForCrewNotice = (message: CrewNoticeMessage): ReadonlyArray<string> => {
  const notice = presentCrewNotice(message);
  if (notice?.kind === "gate") return notice.roster.map((seat) => seat.participantId);
  if (notice?.kind === "seats") return notice.seats.map((seat) => seat.participantId);
  return [];
};

/** "Completed", "Failed", "Interrupted": the run's measured end, with a tone for the pill. */
export const seatRunStatusLabel = (
  runStatus: string,
): { readonly label: string; readonly tone: "good" | "bad" | "warn" | "muted" } => {
  switch (runStatus) {
    case "completed":
      return { label: "Completed", tone: "good" };
    case "failed":
    case "errored":
      return { label: "Failed", tone: "bad" };
    case "interrupted":
    case "cancelled":
      return { label: "Interrupted", tone: "warn" };
    default:
      return { label: runStatus, tone: "muted" };
  }
};

/** The project-relative path the artifacts panel opens, from the notice's logical path. */
export const artifactPanelPath = (logicalPath: string) =>
  logicalPath.startsWith("artifacts/") ? logicalPath.slice("artifacts/".length) : logicalPath;

/** The card's title: what was decided and, for an approval, whether the launch went whole. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return notice.requestKind === "roster" ? "Crew declined" : "Seat declined";
  if (notice.failures.length > 0)
    return notice.requestKind === "roster"
      ? `Crew launched, ${notice.failures.length} ${notice.failures.length === 1 ? "seat" : "seats"} failed to start`
      : "Seat failed to start";
  return notice.requestKind === "roster" ? "Crew launched" : "Seat added";
};

/** The card's last line: what is true of the seats now that the report has been read. */
export const crewGateFooter = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) => {
  if (notice.decision === "declined")
    return "The Captain can revise the request and propose again.";
  const parts: Array<string> = [];
  if (notice.failures.length > 0)
    parts.push(
      `${notice.failures.length} ${notice.failures.length === 1 ? "seat" : "seats"} failed to start; the Captain has each reason.`,
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
