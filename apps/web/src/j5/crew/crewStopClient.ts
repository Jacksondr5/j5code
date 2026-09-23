import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

/** Interrupt every running seat of a Crew on the environment that holds it; nothing is retired. */
export async function stopCrew(environmentId: EnvironmentId, crewInstanceId: string) {
  const result = await j5Environment.stopCrew.run(appAtomRegistry, {
    environmentId,
    input: { crewInstanceId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
