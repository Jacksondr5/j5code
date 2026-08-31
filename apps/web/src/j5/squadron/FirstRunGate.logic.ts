export type SquadronFirstRunGateState = "loading" | "requires_creation" | "ready" | "unavailable";

/**
 * Keeps the first-run decision independent from the eventual authenticated
 * route. Until that route exists, the shell fails closed instead of creating
 * a thread that has no Registrar-assigned Squadron home.
 */
export const resolveSquadronFirstRunGateState = (input: {
  readonly authenticatedRouteAvailable: boolean;
  readonly squadronCount: number | null;
}): SquadronFirstRunGateState => {
  if (!input.authenticatedRouteAvailable) return "unavailable";
  if (input.squadronCount === null) return "loading";
  return input.squadronCount === 0 ? "requires_creation" : "ready";
};
