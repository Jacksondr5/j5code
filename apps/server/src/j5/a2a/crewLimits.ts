/**
 * Input bounds shared by every entry to the crew gate: the MCP verbs a Captain calls and the HTTP
 * route the human's card submits. One module so the two cannot drift apart. Leaf on purpose (no
 * service imports) because the proposal store, the toolkit, and the routes all read it.
 */
export { CREW_SEAT_CAP } from "@t3tools/contracts/j5";
export const CREW_NAME_MAX_CHARS = 100;
export const CREW_REASON_MAX_CHARS = 500;
export const CREW_TEXT_MAX_CHARS = 8_000;

/**
 * Names are written into the platform's notices ahead of the fields the card parser trusts, so
 * they are one line each: a Crew name is any single line, a seat name is lowercase words joined
 * by hyphens (the shape the web card already enforces, and one a roster line can carry without
 * ambiguity).
 */
export const CREW_NAME_PATTERN = /^[^\r\n]+$/;
export const CREW_SEAT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type CrewSeatShapeProblem =
  | { readonly field: "seat"; readonly detail: string }
  | { readonly field: "reason"; readonly detail: string }
  | { readonly field: "instructions"; readonly detail: string };

/** The bound a seat breaks, if any; checked at every door so human-edited seats meet the same rule. */
export const crewSeatShapeProblem = (seat: {
  readonly seat: string;
  readonly agentId: string | null;
  readonly reason: string;
  readonly instructions?: string | undefined;
}): CrewSeatShapeProblem | null => {
  if (seat.seat.length === 0 || seat.seat.length > CREW_NAME_MAX_CHARS)
    return {
      field: "seat",
      detail: `Seat names are 1 to ${CREW_NAME_MAX_CHARS} characters.`,
    };
  if (!CREW_SEAT_NAME_PATTERN.test(seat.seat))
    return { field: "seat", detail: "Seat names are lowercase words joined by hyphens." };
  if (seat.reason.length === 0 || seat.reason.length > CREW_REASON_MAX_CHARS)
    return {
      field: "reason",
      detail: `A seat's reason is 1 to ${CREW_REASON_MAX_CHARS} characters.`,
    };
  if (
    seat.instructions !== undefined &&
    (seat.instructions.length === 0 || seat.instructions.length > CREW_TEXT_MAX_CHARS)
  )
    return {
      field: "instructions",
      detail: `Seat instructions are 1 to ${CREW_TEXT_MAX_CHARS} characters.`,
    };
  // A custom seat has no definition behind it, so its instructions are all it runs on; the card
  // requires them and so does every other door.
  if (seat.agentId === null && seat.instructions === undefined)
    return {
      field: "instructions",
      detail: "A custom seat needs instructions, since no saved agent supplies them.",
    };
  return null;
};
