/**
 * The platform's Crew notices as they appear in a Captain's thread, recognized from their tags so
 * the timeline can show a card instead of the raw block. Recognition is strict: a block the
 * parser does not understand stays raw, and prose is never guessed at.
 */
export interface CrewNoticeMessage {
  readonly role: string;
  readonly text: string;
  readonly createdBy?: unknown;
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

export type SeatHandoff =
  | { readonly status: "none declared" }
  | {
      readonly status: "written" | "missing" | "unavailable";
      readonly kind: string;
      /** The logical path the notice names, `artifacts/handoffs/...`. */
      readonly artifactPath: string | null;
      /** The handoff text when the notice carried it inline. */
      readonly body: string | null;
      /** Why an unavailable handoff can never be read, as the notice words it. */
      readonly reason: string | null;
    };

export interface FinishedSeat {
  readonly seat: string;
  readonly crewName: string | null;
  readonly participantId: string;
  readonly threadId: string;
  readonly runStatus: string;
  /** The run's recorded error when it failed, as the notice carried it. */
  readonly failure: string | null;
  readonly handoff: SeatHandoff;
}

export type CrewNoticePresentation =
  | {
      /** One or more seats' finishes, folded into one message when the Captain was mid-turn. */
      readonly kind: "seats";
      readonly seats: ReadonlyArray<FinishedSeat>;
    }
  | {
      /** The gate's decision, posted to the Captain by the platform. */
      readonly kind: "gate";
      readonly proposalId: string;
      readonly requestKind: "roster" | "addition";
      readonly decision: "approved" | "declined";
      /** Who decided, as the server names them in a shared conversation; null anywhere else. */
      readonly decidedBy: string | null;
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
      /** Approved seats whose thread was never created; they are not on the roster. */
      readonly notCreated: ReadonlyArray<{ readonly seat: string; readonly detail: string }>;
    };

const GATE_BLOCK = /^<j5_crew_gate>\n([\s\S]*?)\n<\/j5_crew_gate>/;
const ROSTER_LINE =
  /^- ([^:]+): participant_id=(\S+) persona=(\S*) thread_id=(\S+)(?: start=(started|failed|pending))?( \(new\))?$/;

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
  const rosterLines =
    rosterStart === -1
      ? []
      : block
          .slice(rosterStart + "\nroster:\n".length)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
  const roster: Array<CrewRosterSeat> = [];
  for (const line of rosterLines) {
    const seat = ROSTER_LINE.exec(line);
    // A roster line this parser does not understand means the block is not one it understands:
    // the message stays raw rather than rendering as an approved card with seats missing.
    if (seat === null) return null;
    roster.push({
      seat: seat[1]!,
      participantId: seat[2]!,
      agentId: seat[3]!,
      threadId: seat[4]!,
      isNew: seat[6] !== undefined,
      start: seatStart(seat[5]),
    });
  }
  // `seat_failed: <seat> | <run status> | <error>`; the error may itself contain the separator.
  const failures = fields(block, "seat_failed").flatMap((entry) => {
    const [seat, runStatus, ...rest] = entry.split(" | ");
    return seat === undefined || runStatus === undefined || rest.length === 0
      ? []
      : [{ seat, runStatus, detail: decodeFailureField(rest.join(" | ")) }];
  });
  // `seat_not_created: <seat> | <error>`, the same escaping as a failure's error.
  const notCreated = fields(block, "seat_not_created").flatMap((entry) => {
    const [seat, ...rest] = entry.split(" | ");
    return seat === undefined || rest.length === 0
      ? []
      : [{ seat, detail: decodeFailureField(rest.join(" | ")) }];
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
    decidedBy: field(block, "decided_by"),
    crewName: field(block, "crew_name"),
    crewInstanceId: field(block, "crew_instance_id"),
    crewVersion: version === null || !/^\d+$/.test(version) ? null : Number(version),
    roster,
    requestedSeats,
    changes: changes === null || changes === "none" ? null : changes,
    failures,
    pendingSeats: fields(block, "seat_pending"),
    notCreated,
  };
};

const SEAT_OPEN = "<j5_seat_finished>";
const SEAT_BLOCK = /^<j5_seat_finished>\n([\s\S]*?)\n<\/j5_seat_finished>([\s\S]*)$/;
const HANDOFF_BODY = /<handoff_body>\n([\s\S]*?)\n<\/handoff_body>/;
const HANDOFF_FIELD = /^(written|missing|unavailable) \((.+)\)$/;

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
      status: parsed[1] as "written" | "missing" | "unavailable",
      kind: parsed[2]!,
      artifactPath: field(block, "artifact"),
      reason: field(block, "handoff_reason"),
      body:
        bodyMatch === null
          ? null
          : bodyMatch[1]!
              .replace(/<\\\/handoff_body>/g, "</handoff_body>")
              .replace(/<\\j5_seat_finished>/g, "<j5_seat_finished>"),
    };
  }
  return {
    seat,
    crewName: field(block, "crew"),
    participantId,
    threadId,
    runStatus,
    failure: field(block, "failure") === null ? null : decodeFailureField(field(block, "failure")!),
    handoff,
  };
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
  return null;
};

export interface CrewNoticeLine {
  readonly seat: string;
  /** Null when the seat's thread was never created: the line names it and doesn't link. */
  readonly threadId: string | null;
  readonly reason: string;
  readonly tone: "bad" | "warn";
}

const handoffLine = (seat: FinishedSeat): CrewNoticeLine | null => {
  const handoff = seat.handoff;
  if (handoff.status === "missing")
    return {
      seat: seat.seat,
      threadId: seat.threadId,
      reason: `finished · ${handoff.kind} missing`,
      tone: "warn",
    };
  if (handoff.status === "unavailable")
    return {
      seat: seat.seat,
      threadId: seat.threadId,
      reason: `finished · ${handoff.kind} can't be read${handoff.reason === null ? "" : `: ${handoff.reason}`}`,
      tone: "warn",
    };
  return null;
};

/**
 * What the person would act on in a notice, one line per seat: a seat that didn't start, or a run
 * that didn't end clean. A seat that started or finished cleanly has no line; its row on the Fleet
 * page and the Captain's expander says so.
 */
export const crewNoticeLines = (notice: CrewNoticePresentation): ReadonlyArray<CrewNoticeLine> => {
  if (notice.kind === "gate") {
    if (notice.decision !== "approved") return [];
    const threadOf = (seat: string) =>
      notice.roster.find((entry) => entry.seat === seat)?.threadId ?? null;
    return [
      ...notice.failures.map((failure) => ({
        seat: failure.seat,
        threadId: threadOf(failure.seat),
        reason: `couldn't start · ${failure.detail}`,
        tone: "bad" as const,
      })),
      ...notice.notCreated.map((seat) => ({
        seat: seat.seat,
        threadId: null,
        reason: `was never created · ${seat.detail}`,
        tone: "bad" as const,
      })),
      ...notice.pendingSeats.map((seat) => ({
        seat,
        threadId: threadOf(seat),
        reason: "hasn't confirmed it started",
        tone: "warn" as const,
      })),
    ];
  }
  return notice.seats.flatMap((seat): ReadonlyArray<CrewNoticeLine> => {
    if (seat.runStatus === "completed") {
      const line = handoffLine(seat);
      return line === null ? [] : [line];
    }
    const ended =
      seat.runStatus === "failed" || seat.runStatus === "errored"
        ? "run failed"
        : `run ${seat.runStatus}`;
    return [
      {
        seat: seat.seat,
        threadId: seat.threadId,
        reason: seat.failure === null ? ended : `${ended} · ${seat.failure}`,
        tone: "bad",
      },
    ];
  });
};

/** An approved gate or a finish with nothing to act on takes no row in the timeline. */
export const isHiddenCrewNotice = (message: CrewNoticeMessage): boolean => {
  const notice = presentCrewNotice(message);
  if (notice === null || (notice.kind === "gate" && notice.decision === "declined")) return false;
  return crewNoticeLines(notice).length === 0;
};

/** A declined gate's card title. */
export const crewGateTitle = (notice: Extract<CrewNoticePresentation, { kind: "gate" }>) =>
  notice.requestKind === "roster" ? "Crew declined" : "Seat declined";
