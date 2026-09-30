import type {
  CrewPersonaSwap,
  CrewProposalPlaybook,
  CrewProposalSeat,
} from "@t3tools/contracts/j5";

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
