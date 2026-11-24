import type { EnvironmentId } from "@t3tools/contracts";
import type { AddPeerRequest, IssuePeerCredentialRequest } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment, peersQueryAtom } from "../state";
import { runJ5Command } from "../runCommand";

export type { PeerRecord } from "@t3tools/contracts/j5";

/** Each call authorizes against the named environment only, like every other J5 read or write. */
export async function issuePeerCredential(
  environmentId: EnvironmentId,
  input: IssuePeerCredentialRequest,
) {
  const result = await runJ5Command(j5Environment.issuePeerCredential, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function addPeer(environmentId: EnvironmentId, input: AddPeerRequest) {
  const result = await runJ5Command(j5Environment.addPeer, { environmentId, input });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function removePeer(environmentId: EnvironmentId, peerEnvironmentId: string) {
  const result = await runJ5Command(j5Environment.removePeer, {
    environmentId,
    input: { environmentId: peerEnvironmentId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export async function changePeerOrigin(
  environmentId: EnvironmentId,
  peerEnvironmentId: string,
  origin: string,
) {
  const result = await runJ5Command(j5Environment.changePeerOrigin, {
    environmentId,
    input: { environmentId: peerEnvironmentId, origin },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value.peer;
}

export async function listPeerAddresses(environmentId: EnvironmentId) {
  const result = await runJ5Command(j5Environment.listPeerAddresses, {
    environmentId,
    input: {},
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value.origins;
}

export async function probePeer(environmentId: EnvironmentId, origin: string) {
  const result = await runJ5Command(j5Environment.probePeer, {
    environmentId,
    input: { origin },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export function refreshPeers(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peersQueryAtom(environmentId));
}
