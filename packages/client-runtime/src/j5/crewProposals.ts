import type {
  CrewPersonaSwap,
  CrewProposalPlaybook,
  CrewProposalPreviewResponse,
  CrewProposalSeat,
  CrewProposalSeatRuntime,
  CrewSeatWorkspace,
} from "@t3tools/contracts/j5";

interface GateLike {
  readonly status: "open" | "approved" | "declined";
  readonly kind: "roster" | "addition";
  readonly captainThreadId: string;
  readonly approvalMode?: "human" | "automatic";
}

/** Initial rosters and legacy addition requests are answered in their Captain's thread. */
export const rosterGatesForThread = <T extends GateLike>(
  proposals: ReadonlyArray<T>,
  threadId: string | null | undefined,
): ReadonlyArray<T> =>
  threadId == null
    ? []
    : proposals.filter(
        (proposal) =>
          proposal.status === "open" &&
          proposal.approvalMode !== "automatic" &&
          proposal.captainThreadId === threadId,
      );

/** A roster with one seat taken out, as the person removes it on the card. */
export const removeSeat = (seats: ReadonlyArray<CrewProposalSeat>, seatName: string) =>
  seats.filter((seat) => seat.seat !== seatName);

/**
 * Whether a seat will pause for the person's approval in its own thread: any resolved access short
 * of Full access. A saved persona on its own default policy is the exception; its sandbox refuses
 * what it may not do instead of asking. A seat whose runtime has not resolved yet is not counted.
 */
export const crewSeatStopsForApprovals = (
  seat: Pick<CrewProposalSeat, "agentId" | "runtimeMode">,
  runtime: Pick<CrewProposalSeatRuntime, "runtimeMode"> | undefined,
): boolean =>
  runtime !== undefined &&
  runtime.runtimeMode !== "full-access" &&
  (seat.agentId === null || seat.runtimeMode !== undefined);

export const describeCrewSeatWorkspace = (workspace: CrewSeatWorkspace): string =>
  workspace.type === "shared"
    ? "Captain's checkout"
    : workspace.type === "worktree"
      ? `New worktree from ${workspace.baseRef}${workspace.baseCommit === undefined ? "" : ` @ ${workspace.baseCommit.slice(0, 8)}`}`
      : `Existing worktree on ${workspace.branch ?? workspace.worktreePath}`;

/** A step's live title for the card; the id when the definition no longer has it. */
export const stepTitle = (playbook: CrewProposalPlaybook | null, id: string): string =>
  playbook?.steps.find((step) => step.id === id)?.title ?? id;

/** Steps no seat on the card owns, in YAML order; the Captain does them. */
export const unownedSteps = (
  playbook: CrewProposalPlaybook | null,
  seats: ReadonlyArray<Pick<CrewProposalSeat, "steps">>,
): ReadonlyArray<string> =>
  playbook === null
    ? []
    : playbook.steps
        .map(({ id }) => id)
        .filter((id) => !seats.some((seat) => seat.steps?.includes(id)));

/** Seats the person removed from the card that owned steps, so the card can say what they leave. */
export const removedSeatSteps = (
  requested: ReadonlyArray<CrewProposalSeat>,
  seats: ReadonlyArray<CrewProposalSeat>,
): ReadonlyArray<{ readonly seat: string; readonly steps: ReadonlyArray<string> }> =>
  requested.flatMap((seat) =>
    seat.steps === undefined ||
    seat.steps.length === 0 ||
    seats.some((current) => current.seat === seat.seat)
      ? []
      : [{ seat: seat.seat, steps: seat.steps }],
  );

/** "wants planner; lead is a custom seat (turned off)" */
export const describePersonaSwap = (swap: CrewPersonaSwap, seatName: string): string =>
  `wants ${swap.wanted}; ${seatName} is ${swap.seatPersona ?? "a custom seat"}${
    swap.wantedProblem === "missing"
      ? ` (${swap.wanted} is missing)`
      : swap.wantedProblem === "disabled"
        ? ` (${swap.wanted} is turned off)`
        : ""
  }`;

/**
 * Whether a runtime preview answers for exactly these seats. An approval token authorizes only the
 * roster and settings that were shown, so a partial or mismatched preview must never enable it.
 */
export const crewPreviewIsComplete = (
  data: Pick<CrewProposalPreviewResponse, "proposalId" | "approvalToken" | "seats">,
  proposalId: string,
  seats: ReadonlyArray<Pick<CrewProposalSeat, "seat">>,
): boolean =>
  data.proposalId === proposalId &&
  data.approvalToken.length > 0 &&
  data.seats.length === seats.length &&
  seats.every((seat) => data.seats.filter((row) => row.seat === seat.seat).length === 1);

const seatSettings = (seat: CrewProposalSeat) =>
  JSON.stringify([seat.agentId, seat.modelSelection, seat.runtimeMode, seat.workspace, seat.steps]);

/**
 * The previewed runtime rows still true for the seats on screen: a seat whose settings changed
 * since that preview shows nothing rather than an old runtime. These rows explain; only a complete
 * preview of the current seats carries approval authority.
 */
export const crewPreviewRuntimeForSeats = (
  previewRows: ReadonlyArray<CrewProposalSeatRuntime>,
  previewedSeats: ReadonlyArray<CrewProposalSeat>,
  seats: ReadonlyArray<CrewProposalSeat>,
): ReadonlyArray<CrewProposalSeatRuntime> =>
  previewRows.filter((runtime) => {
    const current = seats.find((seat) => seat.seat === runtime.seat);
    const previous = previewedSeats.find((seat) => seat.seat === runtime.seat);
    return (
      current !== undefined &&
      previous !== undefined &&
      seatSettings(current) === seatSettings(previous)
    );
  });
