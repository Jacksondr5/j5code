import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalPreviewRequest, CrewProposalResolveRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { runJ5Command } from "../runCommand";
import { j5Environment } from "../state";

/** Resolve runtime settings on the environment that will launch these exact seats. */
export async function previewCrewProposal(
  environmentId: EnvironmentId,
  input: CrewProposalPreviewRequest,
) {
  const result = await runJ5Command(j5Environment.previewCrewProposal, {
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
  const result = await runJ5Command(j5Environment.resolveCrewProposal, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
