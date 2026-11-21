import {
  introducePeers,
  introducePollingPeer,
  peeringStepTitle,
  pollPeeringStepTitle,
  type PeeringSide,
} from "@t3tools/client-runtime/j5/peering";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { addPeer, issuePeerCredential, removePeer } from "../peering/peeringClient";
import { j5Environment, peersQueryAtom } from "../state";
import type { LinkOps } from "./linkChanges";
import type { PairLinkOps } from "./linkSetup";

export function refreshLinks(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(peerLinkEnvironment.list({ environmentId, input: {} }));
}

/**
 * Whether a server runs J5 Code. Only a descriptor that says otherwise makes it a T3 Code server:
 * one this client has not loaded takes J5's calls, which fail visibly if it has none.
 */
const runsJ5 = (environmentId: EnvironmentId) => {
  const config = appAtomRegistry.get(environmentPresentations.serverConfigsAtom).get(environmentId);
  return config === undefined || config.environment.capabilities.j5PeerPoll === true;
};

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
    // A server that runs T3 Code has upstream's forget alone, which leaves the session it held.
    if (!runsJ5(holder)) {
      const result = await peerLinkEnvironment.unlink.run(appAtomRegistry, {
        environmentId: holder,
        input: { environmentId: other },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return {
        detail: result.value.removed
          ? "That server runs T3 Code, which forgets a link without ending its session on the other server. Revoke it in the other server's Settings → Sharing & access."
          : null,
      };
    }
    const result = await j5Environment.forgetEnvironmentLink.run(appAtomRegistry, {
      environmentId: holder,
      input: { environmentId: other },
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    refreshLinks(holder);
    return { detail: result.value.detail };
  },
  removePeer: async (holder, other) => {
    // Only a J5 server has peers, or sessions recorded for another server's links.
    if (runsJ5(holder)) await removePeer(holder, other);
  },
};

/** What linking a pair calls: the row's own calls, setting up messaging, and a fresh peer record. */
export const pairLinkOps: PairLinkOps = {
  ...linkOps,
  introduce: async (choice, local, remote) => {
    const localSide: PeeringSide = { ...local, origin: choice.localOrigin.trim() };
    const remoteSide: PeeringSide = { ...remote, origin: choice.remoteOrigin.trim() };
    if (choice.connections === "both") {
      const outcome = await introducePeers({
        local: localSide,
        remote: remoteSide,
        issue: (issuer, holder) =>
          issuePeerCredential(issuer.environmentId, {
            environmentId: holder.environmentId,
            label: holder.label,
          }),
        record: (recorder, target, credential) =>
          addPeer(recorder.environmentId, { origin: target.origin, credential }),
      });
      return {
        ok: outcome.ok,
        steps: outcome.steps.map((step) => ({
          title: peeringStepTitle(step.step, localSide, remoteSide),
          status: step.status,
          detail: step.detail,
        })),
      };
    }
    const [poller, storer] =
      choice.connections === "local-only" ? [localSide, remoteSide] : [remoteSide, localSide];
    const outcome = await introducePollingPeer({
      poller,
      storer,
      issue: (issuer, holder) =>
        issuePeerCredential(issuer.environmentId, {
          environmentId: holder.environmentId,
          label: holder.label,
          store: true,
        }),
      record: (recorder, target, credential) =>
        addPeer(recorder.environmentId, { origin: target.origin, credential, poll: true }),
    });
    return {
      ok: outcome.ok,
      steps: outcome.steps.map((step) => ({
        title: pollPeeringStepTitle(step.step, poller, storer),
        status: step.status,
        detail: step.detail,
      })),
    };
  },
  peerRecord: async (holder, other) => {
    const result = await executeAtomQuery(appAtomRegistry, peersQueryAtom(holder), {
      refresh: true,
      reportFailure: false,
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value.find((peer) => peer.environmentId === other) ?? null;
  },
};
