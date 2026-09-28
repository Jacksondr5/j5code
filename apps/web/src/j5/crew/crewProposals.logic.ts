interface GateLike {
  readonly status: "open" | "approved" | "declined";
  readonly kind: "roster" | "addition";
  readonly captainThreadId: string;
}

/**
 * Where each crew gate is answered. The initial roster is a planning question for the thread
 * that asked it, so it renders inline above the Captain's composer; a mid-run addition arrives
 * while the user may be anywhere, so it goes to the inbox bell like other questions.
 */
export const rosterGatesForThread = <T extends GateLike>(
  proposals: ReadonlyArray<T>,
  threadId: string | null | undefined,
): ReadonlyArray<T> =>
  threadId == null
    ? []
    : proposals.filter(
        (proposal) =>
          proposal.status === "open" &&
          proposal.kind === "roster" &&
          proposal.captainThreadId === threadId,
      );

export const inboxCrewRequests = <T extends GateLike>(
  proposals: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  proposals.filter((proposal) => proposal.status === "open" && proposal.kind === "addition");
