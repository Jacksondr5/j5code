import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { useVisibleRefresh } from "../useVisibleRefresh";
import { AddedEnvironmentLinkOffer } from "./AddedEnvironmentLinkOffer";
import { LinkPairRow, type LinkRowServerFacts } from "./LinkPairRow";
import type { LinkPair } from "./linkPairs";
import { LinkServersDialog } from "./LinkServersDialog";
import { refreshManagedLinks, useManagedLinks } from "./managedLinks";

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
  const searchableSetting = useSearchableSetting();
  const links = useManagedLinks();
  const { environments, servers, lists, pairs } = links;
  // A session revoked or expired on another server moves no revision here, and a link's reach is
  // only known when it is listed; reading again on focus covers both.
  const refreshOnFocus = () => refreshManagedLinks(servers);
  useVisibleRefresh(refreshOnFocus, servers.length > 0);
  // Each opening mounts a fresh dialog, so an earlier one's choices and results never carry over.
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
  const awayOf = (id: EnvironmentId) =>
    environments.some(
      (environment) =>
        environment.environmentId === id && environment.connection.phase !== "connected",
    );
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
          awayOf={awayOf}
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
      <LinkServersDialog
        key={dialog.generation}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        links={links}
        defaultServerId={dialog.serverId ?? defaultServerId}
        initialOtherIds={dialog.otherId === null ? [] : [dialog.otherId]}
      />
      <AddedEnvironmentLinkOffer links={links} />
    </SettingsSection>
  );
}
