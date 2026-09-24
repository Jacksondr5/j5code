import type { EnvironmentId } from "@t3tools/contracts";
import type { AddPeerRequest, IssuePeerCredentialRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment, peersQueryAtom } from "../state";

export type { PeerRecord } from "@t3tools/contracts/j5";

/** Each call authorizes against the named environment only, like every other J5 read or write. */
export async function issuePeerCredential(
  environmentId: EnvironmentId,
  input: IssuePeerCredentialRequest,
) {
  const result = await j5Environment.issuePeerCredential.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function addPeer(environmentId: EnvironmentId, input: AddPeerRequest) {
  const result = await j5Environment.addPeer.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function removePeer(environmentId: EnvironmentId, peerEnvironmentId: string) {
  const result = await j5Environment.removePeer.run(appAtomRegistry, {
    environmentId,
    input: { environmentId: peerEnvironmentId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export function refreshPeers(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peersQueryAtom(environmentId));
}
