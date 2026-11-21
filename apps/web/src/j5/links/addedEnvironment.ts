import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

/** The server Add environment last added, until its link offer is shown and answered. */
export const addedEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("j5:links:added-environment"),
);

/** Called by upstream's Add environment when it has added a new server, not a route to a known one. */
export const noteEnvironmentAdded = (environmentId: EnvironmentId | null) =>
  appAtomRegistry.set(addedEnvironmentAtom, environmentId);
