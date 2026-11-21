import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { environmentPresentations } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
import { peeringServerOf } from "../peering/peeringCheck";
import { refreshPeers } from "../peering/peeringClient";
import { j5Environment, peersQueryAtom } from "../state";
import { linkPairs } from "./linkPairs";
import { refreshLinks } from "./linksClient";
import { linkCandidateOf, type LinkCandidate, type LinkSetupServer } from "./linkSetup";

/**
 * Each connected server this client can link from, with its peer records and its links; the key
 * is the connected servers' ids, joined with commas. A server from before upstream's links holds
 * none, so its links are not read.
 */
const managedLinkListsAtom = Atom.family((ids: string) =>
  Atom.make((get) =>
    ids
      .split(",")
      .filter(
        (id): id is EnvironmentId =>
          id !== "" && get(j5Environment.addPeer.permissionAtom(id as EnvironmentId)),
      )
      .map((environmentId) => ({
        environmentId,
        peers: get(peersQueryAtom(environmentId)),
        links:
          get(environmentPresentations.serverConfigsAtom).get(environmentId)?.environment
            .capabilities.peerLinks === true
            ? get(peerLinkEnvironment.list({ environmentId, input: {} }))
            : null,
      })),
  ),
);

export const refreshManagedLinks = (servers: ReadonlyArray<EnvironmentId>) => {
  for (const id of servers) {
    refreshPeers(id);
    refreshLinks(id);
  }
};

/** A server's facts for linking; null until this client holds its descriptor. */
export const linkSetupServerOf = (environment: EnvironmentPresentation): LinkSetupServer | null => {
  const config = environment.serverConfig;
  return config == null
    ? null
    : {
        ...peeringServerOf(environment),
        supportsLinks: config.environment.capabilities.peerLinks === true,
        linkedEnvironmentsEnabled: config.settings.linkedEnvironmentsEnabled,
      };
};

/**
 * The servers this client manages and every link among them, read from each server's peer records
 * and upstream's links. Linking is an administrative act on a server, like pairing links and
 * sessions, so a server this client cannot manage access on is not one of them.
 */
export function useManagedLinks() {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .toSorted((left, right) => left.label.localeCompare(right.label));
  const managed = useAtomValue(
    managedLinkListsAtom(connected.map((environment) => environment.environmentId).join(",")),
  );
  const labelOf = (id: EnvironmentId) =>
    connected.find((environment) => environment.environmentId === id)?.label ?? id;
  const lists = managed.map(({ environmentId, peers, links }) => ({
    environmentId,
    label: labelOf(environmentId),
    peers: peers._tag === "Success" ? peers.value : null,
    links: links === null ? [] : links._tag === "Success" ? links.value.links : null,
    peersError: peers._tag === "Failure" ? formatEnvironmentQueryError(peers.cause) : null,
    linksError:
      links !== null && links._tag === "Failure" ? formatEnvironmentQueryError(links.cause) : null,
  }));
  return {
    environments,
    servers: managed.map(({ environmentId }) => environmentId),
    lists,
    pairs: linkPairs(lists),
  };
}

export type ManagedLinks = ReturnType<typeof useManagedLinks>;

/** Every other server this client knows, as it can or cannot be linked with `localId`, by name. */
export function linkCandidatesFor(
  links: Pick<ManagedLinks, "environments" | "servers" | "pairs" | "lists">,
  localId: EnvironmentId,
): { readonly local: LinkSetupServer | null; readonly candidates: ReadonlyArray<LinkCandidate> } {
  const mine = links.environments.find((environment) => environment.environmentId === localId);
  const local = mine === undefined ? null : linkSetupServerOf(mine);
  if (local === null) return { local, candidates: [] };
  const unreadOf = (ids: ReadonlyArray<EnvironmentId>) =>
    links.lists.find(
      (list) => ids.includes(list.environmentId) && (list.peers === null || list.links === null),
    )?.label ?? null;
  return {
    local,
    candidates: links.environments
      .filter((environment) => environment.environmentId !== localId)
      .toSorted((left, right) => left.label.localeCompare(right.label))
      .map((environment) =>
        linkCandidateOf({
          local,
          other: {
            environmentId: environment.environmentId,
            label: environment.label,
            connected: environment.connection.phase === "connected",
            managed: links.servers.includes(environment.environmentId),
            server: linkSetupServerOf(environment),
          },
          pair:
            links.pairs.find((pair) =>
              [localId, environment.environmentId].every((id) =>
                pair.sides.some((side) => side.environmentId === id),
              ),
            ) ?? null,
          unread: unreadOf([localId, environment.environmentId]),
        }),
      ),
  };
}
