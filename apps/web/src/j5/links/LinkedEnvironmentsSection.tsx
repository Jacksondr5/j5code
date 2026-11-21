import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { environmentPresentations } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
import { PeerIntroductionDialog } from "../peering/PeerIntroductionDialog";
import { refreshPeers } from "../peering/peeringClient";
import { j5Environment, peersQueryAtom } from "../state";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { LinkPairRow, type LinkRowServerFacts } from "./LinkPairRow";
import { linkPairs, type LinkPair } from "./linkPairs";
import { refreshLinks } from "./linksClient";

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

const refreshLists = (serversKey: string) => {
  for (const id of serversKey.split(",")) {
    if (id === "") continue;
    refreshPeers(id as EnvironmentId);
    refreshLinks(id as EnvironmentId);
  }
};

/**
 * Every link among the servers this client manages, one row for each pair: the messages its
 * agents exchange, which is J5's peering, and what each server's agents may do on the other,
 * which is upstream's link for that direction. A pair where neither side is this client's own
 * server is listed too.
 */
export function LinkedEnvironmentsSection({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .toSorted((left, right) => left.label.localeCompare(right.label));
  // Linking is an administrative act on a server, like pairing links and sessions.
  const managed = useAtomValue(
    managedLinkListsAtom(connected.map((environment) => environment.environmentId).join(",")),
  );
  const servers = managed.map(({ environmentId }) => environmentId);
  // A session revoked or expired on another server moves no revision here, and a link's reach is
  // only known when it is listed; reading again on focus covers both.
  const serversKey = servers.join(",");
  const refreshOnFocus = () => refreshLists(serversKey);
  useVisibleRefresh(refreshOnFocus, servers.length > 0);
  // Each opening mounts a fresh dialog, so an earlier one's fields and steps never carry over.
  const [dialog, setDialog] = useState<{
    readonly generation: number;
    readonly open: boolean;
    readonly serverId: EnvironmentId | null;
    readonly otherId: EnvironmentId | null;
  }>({ generation: 0, open: false, serverId: null, otherId: null });

  const defaultServerId =
    primaryEnvironmentId !== null && servers.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : (servers[0] ?? null);
  if (defaultServerId === null) return null;

  const openDialog = (serverId: EnvironmentId | null, otherId: EnvironmentId | null) =>
    setDialog((current) => ({ generation: current.generation + 1, open: true, serverId, otherId }));
  const setUpMessaging = (pair: LinkPair) => {
    const first = pair.sides.find((side) => servers.includes(side.environmentId)) ?? pair.sides[0];
    const second = pair.sides[0] === first ? pair.sides[1] : pair.sides[0];
    openDialog(first.environmentId, second.environmentId);
  };

  const labelOf = (id: EnvironmentId) =>
    connected.find((environment) => environment.environmentId === id)?.label ?? id;
  const factsOf = (id: EnvironmentId): LinkRowServerFacts | null => {
    const config = environments.find(
      (environment) => environment.environmentId === id,
    )?.serverConfig;
    return config == null
      ? null
      : {
          linkedEnvironmentsEnabled: config.settings.linkedEnvironmentsEnabled,
          supportsMessaging: config.environment.capabilities.j5PeerPoll === true,
        };
  };
  const lists = managed.map(({ environmentId, peers, links }) => ({
    environmentId,
    label: labelOf(environmentId),
    peers: peers._tag === "Success" ? peers.value : null,
    links: links === null ? [] : links._tag === "Success" ? links.value.links : null,
    peersError: peers._tag === "Failure" ? formatEnvironmentQueryError(peers.cause) : null,
    linksError:
      links !== null && links._tag === "Failure" ? formatEnvironmentQueryError(links.cause) : null,
  }));
  const pairs = linkPairs(lists);
  const search = searchableSetting("linked-environments");

  return (
    <SettingsSection
      id={search.id}
      title={search.title}
      description="Link two of your servers so their agents can message each other and use tools on the other server."
      headerAction={
        <Button size="xs" variant="default" onClick={() => openDialog(null, null)}>
          <PlusIcon className="size-3" />
          Link
        </Button>
      }
    >
      {pairs.map((pair) => (
        <LinkPairRow
          key={pair.key}
          pair={pair}
          factsOf={factsOf}
          onSetUpMessaging={setUpMessaging}
        />
      ))}
      {pairs.length === 0 && lists.some((list) => list.peers !== null) ? (
        <SettingsRow title="No linked environments" />
      ) : null}
      {lists.flatMap((list) =>
        [list.peersError, list.linksError].flatMap((error, index) =>
          error === null
            ? []
            : [
                <SettingsRow
                  key={`${list.environmentId}:${String(index)}`}
                  title={`Couldn't read ${list.label}'s links`}
                  description={error}
                />,
              ],
        ),
      )}
      <PeerIntroductionDialog
        key={dialog.generation}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        servers={servers}
        defaultServerId={dialog.serverId ?? defaultServerId}
        defaultOtherId={dialog.otherId}
        onPeered={(first, second) => {
          refreshPeers(first);
          refreshPeers(second);
        }}
      />
    </SettingsSection>
  );
}
