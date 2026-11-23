import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { j5Environment } from "../state";
import { runJ5Command } from "../runCommand";

/**
 * Retire a Crew as a unit on the environment that holds it. The caller has already shown the
 * person every seat's consequences and taken their confirmation; nothing is deleted.
 */
export async function archiveCrew(environmentId: EnvironmentId, crewInstanceId: string) {
  const result = await runJ5Command(j5Environment.archiveCrew, {
    environmentId,
    input: { crewInstanceId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
