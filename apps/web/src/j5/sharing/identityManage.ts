import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { J5_IDENTITY_WS_METHODS } from "@t3tools/contracts/j5";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";
import { ownedEnvironmentIdsAtom } from "./access";

const command = <Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(tag: Tag) =>
  createEnvironmentRpcCommand(connectionAtomRuntime, { label: `environment-data:${tag}`, tag });

/**
 * Sign-in through J5 Connect on one server, for its Owners: the J5 Connect it trusts, who signed
 * in, and who is waiting to be let in. Every change needs upstream's "Manage access".
 */
export const identityManage = {
  identity: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-identity:get",
    tag: J5_IDENTITY_WS_METHODS.getIdentity,
    staleTimeMs: 0,
    // A sign-in, a request or a decision moves the same revision as a change of people.
    refreshTrigger: j5Environment.rereadOn("sharing"),
  }),
  returnUrls: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-identity:return-urls",
    tag: J5_IDENTITY_WS_METHODS.returnUrls,
    staleTimeMs: 0,
  }),
  join: command(J5_IDENTITY_WS_METHODS.join),
  leave: command(J5_IDENTITY_WS_METHODS.leave),
  grant: command(J5_IDENTITY_WS_METHODS.grant),
  bind: command(J5_IDENTITY_WS_METHODS.bind),
  decline: command(J5_IDENTITY_WS_METHODS.decline),
  unbind: command(J5_IDENTITY_WS_METHODS.unbind),
};

export const identityQuery = (environmentId: EnvironmentId) =>
  identityManage.identity({ environmentId, input: {} });

export function refreshIdentity(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(identityQuery(environmentId));
}

/**
 * The servers this person owns with accounts waiting to be let in, for the Inbox (J5 Connect,
 * decision 4). A server that has not answered counts as having none.
 */
export const ownedAccessRequestsAtom = Atom.make((get) => {
  const waiting: Array<{ readonly environmentId: EnvironmentId; readonly count: number }> = [];
  for (const environmentId of get(ownedEnvironmentIdsAtom)) {
    const identity = AsyncResult.getOrElse(get(identityQuery(environmentId)), () => null);
    const count = identity?.requests.length ?? 0;
    if (count > 0) waiting.push({ environmentId, count });
  }
  return waiting;
}).pipe(Atom.withLabel("j5:identity:owned-access-requests"));
