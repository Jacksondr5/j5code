import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";

export type ScopedCrewRuntimeRequest = CrewRuntimeRequestItem & {
  readonly environmentId: EnvironmentId;
};

/** Every environment's Crew requests, each tagged with the environment that must answer it. */
export const mergeCrewRuntimeRequestSources = (
  sources: J5ReadSources<ReadonlyArray<CrewRuntimeRequestItem>>,
): ReadonlyArray<ScopedCrewRuntimeRequest> =>
  sources.sources.flatMap((source) =>
    (source.data ?? []).map((request) => ({ ...request, environmentId: source.environmentId })),
  );

/** The request ids the Inbox currently holds for one thread on one environment. */
export const inboxRequestIdsForThread = (
  requests: ReadonlyArray<ScopedCrewRuntimeRequest>,
  environmentId: EnvironmentId | undefined,
  threadId: string | null | undefined,
): ReadonlySet<string> =>
  new Set(
    environmentId === undefined || threadId == null
      ? []
      : requests
          .filter(
            (request) => request.environmentId === environmentId && request.threadId === threadId,
          )
          .map((request) => request.requestId),
  );

/**
 * A Crew thread hands the composer only what the Inbox does not hold. The filter is by request id,
 * so a request the Inbox has not read yet (or cannot read, on a server without the route) stays
 * inline: a prompt is never hidden from both places.
 */
export const withoutInboxRequests = <
  T extends {
    readonly approvals: ReadonlyArray<{ readonly requestId: string }>;
    readonly userInputs: ReadonlyArray<{ readonly requestId: string }>;
  },
>(
  pending: T,
  inboxIds: ReadonlySet<string>,
): T =>
  inboxIds.size === 0
    ? pending
    : {
        ...pending,
        approvals: pending.approvals.filter((request) => !inboxIds.has(request.requestId)),
        userInputs: pending.userInputs.filter((request) => !inboxIds.has(request.requestId)),
      };

/**
 * The bell: open asks, mid-run seat requests, and Crew threads' provider requests. An unknown ask
 * count still shows the Crew items, since those were read.
 */
export const inboxBadgeCount = (
  openAsks: number | null,
  crewSeatRequests: number,
  crewRuntimeRequests: number,
): number | null => {
  const crew = crewSeatRequests + crewRuntimeRequests;
  return openAsks === null ? (crew > 0 ? crew : null) : openAsks + crew;
};
