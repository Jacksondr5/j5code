import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AssignImportedThreadsRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment, squadronQueryAtom } from "../state";

import { J5HttpError } from "@t3tools/client-runtime/j5/http";

export type { AssignImportedThreadsResponse, ManagedSquadron } from "@t3tools/contracts/j5";
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

/** The id stays stable, so every home, membership, Crew, and thread label follows the new name. */
export async function renameSquadron(
  environmentId: EnvironmentId,
  input: { readonly squadronId: string; readonly name: string },
) {
  const result = await j5Environment.renameSquadron.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Homes a folder's imported, still-unhomed conversations in one Squadron on the owning server. */
export async function assignImportedThreads(
  environmentId: EnvironmentId,
  input: AssignImportedThreadsRequest,
) {
  const result = await j5Environment.assignImportedThreads.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** How many agent threads deleting the Squadron would remove. */
export async function previewSquadronDelete(
  environmentId: EnvironmentId,
  input: { readonly squadronId: string },
) {
  const result = await j5Environment.previewSquadronDelete.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Hard delete. Without `force` the server answers 409 while live agents or Crews remain; with it, their threads are deleted too. */
export async function deleteSquadron(
  environmentId: EnvironmentId,
  input: { readonly squadronId: string; readonly force?: boolean },
) {
  const result = await j5Environment.deleteSquadron.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

const isSquadronHttpError = Schema.is(J5HttpError);

/** A 4xx means the server refused and created nothing; anything else may have landed. */
export const isDefiniteSquadronRejection = (error: unknown): boolean =>
  isSquadronHttpError(error) && error.status >= 400 && error.status < 500;
