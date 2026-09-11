import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import {
  createJ5ReadSourcesAtom,
  type J5ReadSources,
} from "@t3tools/client-runtime/j5/readSources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
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
      if (options.force !== true && (source.status === "unsupported" || source.refreshing))
        return [];
      const atom = queryAtom(source.environmentId);
      appAtomRegistry.refresh(atom);
      return [executeAtomQuery(appAtomRegistry, atom, { reportFailure: false })];
    }),
  );
}
