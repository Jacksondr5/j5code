import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment, squadronQueryAtom } from "../state";

export type { ManagedSquadron } from "@t3tools/contracts/j5";
export {
  J5HttpError as SquadronHttpError,
  listSquadrons as listSquadronsEffect,
  createSquadron as createSquadronEffect,
} from "@t3tools/client-runtime/j5/http";

export async function listSquadrons(environmentId: EnvironmentId) {
  const result = await executeAtomQuery(appAtomRegistry, squadronQueryAtom(environmentId));
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function createSquadron(
  environmentId: EnvironmentId,
  input: { readonly name: string; readonly projectId: ProjectId },
) {
  const result = await j5Environment.createSquadron.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
