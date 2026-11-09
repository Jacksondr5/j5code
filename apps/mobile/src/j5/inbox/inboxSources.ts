import {
  type CrewApprovalReadPlan,
  crewApprovalReadPlan,
} from "@t3tools/client-runtime/j5/crew-inbox-requests";
import { writesNowhere } from "@t3tools/client-runtime/j5/inbox";
import {
  createJ5ReadSourcesAtom,
  type J5ReadSources,
} from "@t3tools/client-runtime/j5/readSources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRuntimeRequestsResponse } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

// A person who can answer nothing, a Viewer everywhere or a device not yet placed, has no inbox
// (Inbox AC14): their source reads as unsupported and is not asked.
const writesNowhereAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => writesNowhere(get(j5Sharing.connectionAccess(environmentId)))),
);

const sourcesInput = {
  capability: "j5ProjectLedger" as const,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  guestAtom: writesNowhereAtom,
};

export const openInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "open" } });
export const answeredInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "answered" } });
export const inboxCountQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.openCount({ environmentId, input: {} });

/** Every connected server's open asks for this person; the server's inbox signal rereads them. */
export const openInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-open-sources",
  queryAtom: openInboxQueryAtom,
});
export const answeredInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-answered-sources",
  queryAtom: answeredInboxQueryAtom,
});
export const inboxCountSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:inbox-count-sources",
  queryAtom: inboxCountQueryAtom,
});

export const crewRequestsQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.crewRuntimeRequests({ environmentId, input: {} });

/** The servers with a thread waiting on an approval or a question; the same value until that changes. */
export const crewRequestReadAtom = Atom.make((get): CrewApprovalReadPlan => {
  const next = crewApprovalReadPlan(get(environmentThreadShells.threadShellsAtom));
  const previous = Option.getOrNull(get.self<CrewApprovalReadPlan>());
  return previous !== null && previous.key === next.key ? previous : next;
}).pipe(Atom.withLabel("mobile-j5:crew-request-read"));

const NO_CREW_REQUESTS = AsyncResult.success<CrewRuntimeRequestsResponse>({
  requests: [],
  questions: [],
});

// A server with no thread waiting has no seat approval or question to list, so it isn't asked, as
// on web. The server decides which waiting threads belong in the Inbox.
const gatedCrewRequestsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(crewRequestReadAtom).environmentIds.includes(environmentId)
      ? get(crewRequestsQueryAtom(environmentId))
      : NO_CREW_REQUESTS,
  ).pipe(Atom.withLabel(`mobile-j5:gated-crew-requests:${environmentId}`)),
);

/** Seat approvals and placed agents' questions on every connected server; the server's signal rereads them. */
export const crewRequestSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "mobile-j5:crew-request-sources",
  queryAtom: gatedCrewRequestsAtom,
});

/**
 * Reads each connected server's source again, as the Inbox screen does when it comes into view.
 * A read already in flight is left to finish.
 */
export function refreshInboxSources<A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  only?: ReadonlyArray<EnvironmentId>,
) {
  for (const source of appAtomRegistry.get(sourcesAtom).sources) {
    if (!source.connected || source.status === "unsupported" || source.refreshing) continue;
    if (only !== undefined && !only.includes(source.environmentId)) continue;
    appAtomRegistry.refresh(queryAtom(source.environmentId));
  }
}

/** Reads again the Crew requests of the servers with a thread waiting. */
export const refreshCrewRequestSources = () =>
  refreshInboxSources(
    crewRequestSourcesAtom,
    crewRequestsQueryAtom,
    appAtomRegistry.get(crewRequestReadAtom).environmentIds,
  );

const readConnectedSources = <A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  only?: ReadonlyArray<EnvironmentId>,
) =>
  appAtomRegistry.get(sourcesAtom).sources.flatMap((source) =>
    !source.connected ||
    source.status === "unsupported" ||
    (only !== undefined && !only.includes(source.environmentId))
      ? []
      : [
          executeAtomQuery(appAtomRegistry, queryAtom(source.environmentId), {
            refresh: true,
            reportFailure: false,
            reportDefect: false,
          }),
        ],
  );

/** Reads the Crew requests of the servers with a thread waiting, and settles when all have answered. */
export const readCrewRequestSources = (environmentId?: EnvironmentId) => {
  const waiting = appAtomRegistry.get(crewRequestReadAtom).environmentIds;
  return Promise.all(
    readConnectedSources(
      crewRequestSourcesAtom,
      crewRequestsQueryAtom,
      environmentId === undefined ? waiting : waiting.filter((id) => id === environmentId),
    ),
  );
};

/** Reads every connected server's asks and Crew requests, and settles when all have answered. */
export const readInboxSources = () =>
  Promise.all([
    ...readConnectedSources(openInboxSourcesAtom, openInboxQueryAtom),
    ...readConnectedSources(answeredInboxSourcesAtom, answeredInboxQueryAtom),
    readCrewRequestSources(),
  ]);
