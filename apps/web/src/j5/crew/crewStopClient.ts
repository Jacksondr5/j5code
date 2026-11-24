import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { j5Environment } from "../state";
import { runJ5Command } from "../runCommand";

/** Interrupt every running seat of a Crew on the environment that holds it; nothing is retired. */
export async function stopCrew(environmentId: EnvironmentId, crewInstanceId: string) {
  const result = await runJ5Command(j5Environment.stopCrew, {
    environmentId,
    input: { crewInstanceId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
