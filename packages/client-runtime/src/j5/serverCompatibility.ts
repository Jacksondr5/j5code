import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { ConnectionBlockedError } from "../connection/model.ts";

/**
 * A J5 server from before its ledger was re-keyed to projects still reports the old ledger and
 * not the new one. This client's J5 views cannot read that ledger, so it does not connect: the
 * person updates the server instead of meeting views that quietly show nothing. A server that
 * reports neither (plain T3 Code, for one) has no J5 ledger at all and connects as it always has,
 * with the J5 views reporting that source as unsupported.
 */
export function j5ServerCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  const { j5ProjectLedger, j5Squadrons } = descriptor.capabilities;
  if (j5Squadrons !== true || j5ProjectLedger === true) return null;
  return new ConnectionBlockedError({
    reason: "unsupported",
    detail: `This client requires a newer server. Update the server on ${descriptor.label} to connect.`,
  });
}
