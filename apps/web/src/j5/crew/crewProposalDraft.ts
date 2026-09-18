import type { CrewProposalSeat } from "@t3tools/contracts/j5";
import type { CrewSeatDraft } from "./crewSeatRuntime";

/** The persona choice for a seat that runs without a persona: named and briefed on the card. */
export const CUSTOM_AGENT = "__custom__";

/** Pure roster edits so the card's behavior is testable without rendering. */
export const removeSeat = (seats: ReadonlyArray<CrewProposalSeat>, seatName: string) =>
  seats.filter((seat) => seat.seat !== seatName);

export const addSeat = (
  seats: ReadonlyArray<CrewProposalSeat>,
  draft: CrewSeatDraft,
): { readonly seats: ReadonlyArray<CrewProposalSeat>; readonly error: string | null } => {
  const seatName = draft.seat.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(seatName))
    return { seats, error: "Seat names are lowercase words joined by hyphens." };
  if (seats.some((seat) => seat.seat === seatName))
    return { seats, error: `Seat ${seatName} already exists.` };
  if (draft.agentId.length === 0)
    return { seats, error: "Pick a persona for the seat, or Custom seat." };
  const custom = draft.agentId === CUSTOM_AGENT;
  const instructions = draft.instructions.trim();
  // A custom seat has no persona; its instructions are all it will know beyond the brief.
  if (custom && instructions.length === 0)
    return { seats, error: "Give the custom seat its instructions." };
  return {
    seats: [
      ...seats,
      {
        seat: seatName,
        agentId: custom ? null : draft.agentId,
        reason: "Added by the user",
        ...(instructions ? { instructions } : {}),
        ...(custom && draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
        ...(custom && draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      },
    ],
    error: null,
  };
};

/** Validate a modal edit without mutating the current roster or the Captain's reason. */
export const saveSeat = (
  seats: ReadonlyArray<CrewProposalSeat>,
  seatName: string,
  draft: CrewSeatDraft,
): { readonly seats: ReadonlyArray<CrewProposalSeat>; readonly error: string | null } => {
  const current = seats.find((seat) => seat.seat === seatName);
  if (!current) return { seats, error: "This seat is no longer in the roster." };
  const validated = addSeat(removeSeat(seats, seatName), { ...draft, seat: seatName });
  if (validated.error !== null) return { seats, error: validated.error };
  const updated = { ...validated.seats[validated.seats.length - 1]!, reason: current.reason };
  return {
    seats: seats.map((seat) => (seat.seat === seatName ? updated : seat)),
    error: null,
  };
};

/** Names are catalog metadata; runtime and access are disclosed only by the server preview. */
export const describeSeatAgent = (
  rows: ReadonlyArray<{
    readonly personaId: string;
    readonly displayName: string;
  }>,
  agentId: string | null,
): string => {
  if (agentId === null) return "Custom seat";
  const row = rows.find((candidate) => candidate.personaId === agentId);
  return row?.displayName ?? agentId;
};
