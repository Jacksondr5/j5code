import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export { readOpenInboxCount as readOpenInboxCountEffect } from "@t3tools/client-runtime/j5/http";

export async function readOpenInboxCount(environmentId: EnvironmentId, personId?: string) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    j5Environment.openCount({
      environmentId,
      input: personId === undefined ? {} : { personId },
    }),
  );
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
