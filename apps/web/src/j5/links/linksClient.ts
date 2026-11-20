import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { serverEnvironment } from "../../state/server";
import { removePeer } from "../peering/peeringClient";
import { j5Environment } from "../state";
import type { LinkOps } from "./linkChanges";

export function refreshLinks(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peerLinkEnvironment.list({ environmentId, input: {} }));
}

/** Each call authorizes against the server it names, as every other read or write does. */
export const linkOps: LinkOps = {
  enableLinkedEnvironments: async (environmentId) => {
    const result = await serverEnvironment.updateSettings.run(appAtomRegistry, {
      environmentId,
      input: { patch: { linkedEnvironmentsEnabled: true } },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  },
  mintPairingCode: async (environmentId, access) => {
    const minted = await mintPairingCodeOn(environmentId, access);
    if (Result.isFailure(minted)) throw new Error(linkRequestFailureMessage(minted.failure));
    return minted.success;
  },
  link: async (holder, input) => {
    const result = await peerLinkEnvironment.link.run(appAtomRegistry, {
      environmentId: holder,
      input,
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  },
  forget: async (holder, other) => {
    const result = await j5Environment.forgetEnvironmentLink.run(appAtomRegistry, {
      environmentId: holder,
      input: { environmentId: other },
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    refreshLinks(holder);
    return { detail: result.value.detail };
  },
  removePeer: async (holder, other) => {
    await removePeer(holder, other);
  },
};
