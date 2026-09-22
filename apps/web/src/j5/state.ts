import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { executeJ5Request, J5HttpError } from "@t3tools/client-runtime/j5/http";
import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import {
  createJ5ReadSourcesAtom,
  type J5ReadSources,
} from "@t3tools/client-runtime/j5/readSources";
import { createEnvironmentCommand, executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { J5_API_PATHS, ManagedSquadron } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";

export const j5Environment = createJ5EnvironmentAtoms(connectionAtomRuntime);

const sourcesInput = {
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  sessionStateValueAtom: environmentSession.sessionStateValueAtom,
};

export const squadronQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.squadrons({ environmentId, input: {} });
export const openInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "open" } });
export const answeredInboxQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.inbox({ environmentId, input: { status: "answered" } });
export const inboxCountQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.openCount({ environmentId, input: {} });
export const crewProposalsQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.crewProposals({ environmentId, input: {} });
export const fleetQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.fleet({ environmentId, input: {} });
export const fleetDetailQueryAtom = (environmentId: EnvironmentId) =>
  j5Environment.fleet({ environmentId, input: { includeRetired: true } });

export const squadronSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:squadron-sources",
  capability: "j5Squadrons",
  queryAtom: squadronQueryAtom,
});
export const openInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:inbox-sources",
  capability: "j5HumanInbox",
  queryAtom: openInboxQueryAtom,
});
export const answeredInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:answered-inbox-sources",
  capability: "j5HumanInbox",
  queryAtom: answeredInboxQueryAtom,
});
export const crewProposalSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:crew-proposal-sources",
  capability: "j5HumanInbox",
  queryAtom: crewProposalsQueryAtom,
});
export const fleetSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:fleet-sources",
  capability: "j5Squadrons",
  queryAtom: fleetQueryAtom,
});
export const fleetDetailSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:fleet-detail-sources",
  capability: "j5Squadrons",
  queryAtom: fleetDetailQueryAtom,
});
export const inboxCountSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:inbox-count-sources",
  capability: "j5HumanInbox",
  queryAtom: inboxCountQueryAtom,
});

/** Background refresh never interrupts an in-flight read; explicit mutations can force a newer read. */
export async function refreshJ5Sources<A>(
  sourcesAtom: Atom.Atom<J5ReadSources<A>>,
  queryAtom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  options: { readonly environmentId?: EnvironmentId; readonly force?: boolean } = {},
) {
  const { sources } = appAtomRegistry.get(sourcesAtom);
  return Promise.all(
    sources.flatMap((source) => {
      if (
        !source.connected ||
        (options.environmentId !== undefined && source.environmentId !== options.environmentId)
      )
        return [];
      if (source.status === "unsupported" || (options.force !== true && source.refreshing))
        return [];
      const atom = queryAtom(source.environmentId);
      appAtomRegistry.refresh(atom);
      return [executeAtomQuery(appAtomRegistry, atom, { reportFailure: false })];
    }),
  );
}

// TEMPORARY STUB: remove once client-runtime's `createJ5EnvironmentAtoms` ships
// `renameSquadron` and `deleteSquadron` (owned by the server seat), then point
// `squadronLifecycleCommands` at `j5Environment.renameSquadron` / `j5Environment.deleteSquadron`.
const stubPreparedConnection = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (Option.isNone(prepared) || state.phase !== "connected") {
    return yield* new J5HttpError({ status: 0, detail: "The environment is disconnected." });
  }
  return prepared.value;
});
const stubSquadronPath = (squadronId: string) =>
  `${J5_API_PATHS.squadrons}/${encodeURIComponent(squadronId)}`;
const StubRenameSquadronResponse = Schema.Struct({ squadron: ManagedSquadron });

/** Rename and delete address the owning environment; the caller passes its id, never the primary. */
export const squadronLifecycleCommands = {
  rename: createEnvironmentCommand(connectionAtomRuntime, {
    label: "web-j5:rename-squadron",
    execute: (input: { readonly squadronId: string; readonly name: string }) =>
      Effect.gen(function* () {
        const prepared = yield* stubPreparedConnection;
        const request = yield* HttpClientRequest.patch(stubSquadronPath(input.squadronId)).pipe(
          HttpClientRequest.bodyJson({ name: input.name }),
        );
        const response = yield* executeJ5Request(prepared, request, 15_000);
        return (yield* HttpClientResponse.schemaBodyJson(StubRenameSquadronResponse)(response))
          .squadron;
      }),
  }),
  delete: createEnvironmentCommand(connectionAtomRuntime, {
    label: "web-j5:delete-squadron",
    execute: (input: { readonly squadronId: string }) =>
      Effect.gen(function* () {
        const prepared = yield* stubPreparedConnection;
        yield* executeJ5Request(
          prepared,
          HttpClientRequest.delete(stubSquadronPath(input.squadronId)),
          15_000,
        );
        return { squadronId: input.squadronId };
      }),
  }),
};
