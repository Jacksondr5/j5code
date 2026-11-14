import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewRequest, CrewProposalResolveRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../state/atom-registry";
import { j5Environment } from "../state";

/** Resolve runtime settings on the environment that will launch these exact seats. */
export async function previewCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalPreviewRequest,
) {
  const result = await j5Environment.previewCrewProposal.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Approve (with the final seats) or decline one proposal on the environment that holds it. */
export async function resolveCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalResolveRequest,
) {
  const result = await j5Environment.resolveCrewProposal.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
