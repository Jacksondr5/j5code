/**
 * Input bounds shared by every entry to the crew gate: the MCP verbs a Captain calls and the HTTP
 * route the human's card submits. One module so the two cannot drift apart. Leaf on purpose (no
 * service imports) because the proposal store, the toolkit, and the routes all read it.
 */
export { CREW_SEAT_CAP } from "@t3tools/contracts/j5";
export const CREW_NAME_MAX_CHARS = 100;
export const CREW_REASON_MAX_CHARS = 500;
export const CREW_TEXT_MAX_CHARS = 8_000;
