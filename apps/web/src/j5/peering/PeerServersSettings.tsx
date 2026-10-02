import { AuthAccessWriteScope, EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { peersQueryAtom } from "../state";
import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { refreshPeers, removePeer, type PeerRecord } from "./peeringClient";
import {
  isPeerCredentialRejected,
  peerPollState,
  peerPollStoppedReason,
} from "@t3tools/contracts/j5";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * The servers this environment exchanges agent messages with. A peer is also
 * an authorized session in the list above; this section is where the pairing
 * is made and where it is taken apart. Removal is mutual when this client can
 * manage the other server too, as the introduction was; otherwise it says what
 * is left to do there.
 */
export function PeerServersSettings({
  primaryEnvironmentId,
  canManage,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly canManage: boolean;
}) {
  const peers = useEnvironmentQuery(
    primaryEnvironmentId === null ? null : peersQueryAtom(primaryEnvironmentId),
  );
  const { environments } = useEnvironments();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Each opening mounts a fresh dialog, so a previous introduction's fields and steps never carry over.
  const [dialogGeneration, setDialogGeneration] = useState(0);
  // Peering a pair again starts the dialog with that pair's remote server chosen.
  const [dialogOther, setDialogOther] = useState<EnvironmentId | null>(null);
  const openDialog = (otherEnvironmentId: EnvironmentId | null) => {
    setDialogOther(otherEnvironmentId);
    setDialogGeneration((generation) => generation + 1);
    setDialogOpen(true);
  };

  // Peering is an administrative act on this server, like pairing links and sessions.
  if (primaryEnvironmentId === null || !canManage) return null;

  return (
    <SettingsSection
      title="Peer servers"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Add peer"
          onClick={() => openDialog(null)}
        >
          <PlusIcon className="size-3" />
          <span>Add peer</span>
        </Button>
      }
    >
      {(peers.data ?? []).map((peer) => (
        <PeerRow
          key={peer.environmentId}
          peer={peer}
          primaryEnvironmentId={primaryEnvironmentId}
          onPeerAgain={() => openDialog(EnvironmentId.make(peer.environmentId))}
          otherEnvironmentId={
            environments.find(
              (environment) =>
                environment.environmentId === peer.environmentId &&
                environment.connection.phase === "connected",
            )?.environmentId ?? null
          }
        />
      ))}
      {peers.data !== null && peers.data.length === 0 ? (
        <SettingsRow
          title="No peers yet"
          description="Peer this server with another environment you are connected to so their agents can exchange messages. Agents address each other by participant id and see which server each one lives on."
        />
      ) : null}
      {peers.error !== null ? (
        <SettingsRow title="Couldn't read peers" description={peers.error} />
      ) : null}
      <PeerIntroductionDialog
        key={dialogGeneration}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        primaryEnvironmentId={primaryEnvironmentId}
        initialOtherEnvironmentId={dialogOther}
        onPeered={(otherEnvironmentId) => {
          refreshPeers(primaryEnvironmentId);
          refreshPeers(otherEnvironmentId);
        }}
      />
    </SettingsSection>
  );
}

function PeerRow({
  peer,
  primaryEnvironmentId,
  onPeerAgain,
  otherEnvironmentId,
}: {
  readonly peer: PeerRecord;
  readonly primaryEnvironmentId: EnvironmentId;
  readonly onPeerAgain: () => void;
  /** The peer as one of this client's connected environments, when it is one. */
  readonly otherEnvironmentId: EnvironmentId | null;
}) {
  // The hook needs an id; the result is read only when the peer is a connected environment.
  const otherSession = useEnvironmentSessionState(otherEnvironmentId ?? primaryEnvironmentId);
  const otherManageable =
    otherEnvironmentId !== null &&
    otherSession.data?.authenticated === true &&
    (otherSession.data.scopes?.includes(AuthAccessWriteScope) ?? false);
  const [removing, setRemoving] = useState(false);

  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      otherManageable
        ? `Remove ${peer.label} as a peer? Both servers drop their record of the other and revoke the credential they issued. Agents on the two servers will no longer be able to message each other.`
        : `Remove ${peer.label} as a peer? This server drops its record of ${peer.label} and revokes the credential ${peer.label} holds here. ${peer.label} keeps its own record of this server until you remove it there, and agents on the two servers will no longer be able to message each other.`,
      { variant: "destructive" },
      { confirmLabel: "Remove peer" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setRemoving(true);
    try {
      await removePeer(primaryEnvironmentId, peer.environmentId);
      refreshPeers(primaryEnvironmentId);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not remove the peer",
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setRemoving(false);
      return;
    }
    if (otherManageable && otherEnvironmentId !== null) {
      try {
        await removePeer(otherEnvironmentId, primaryEnvironmentId);
        refreshPeers(otherEnvironmentId);
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: `Removed here, but not on ${peer.label}`,
          description: `${peer.label} still lists this server as a peer. Remove it there. ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    setRemoving(false);
  };

  return (
    <SettingsRow
      title={peer.label}
      description={<PeerStatus peer={peer} />}
      control={
        <span className="flex gap-2">
          {/* Only peering again fixes a rejected credential; a mismatch needs an update instead. */}
          {isPeerCredentialRejected(peer) ? (
            <Button size="sm" variant="outline" disabled={removing} onClick={onPeerAgain}>
              Peer again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={removing} onClick={() => void remove()}>
            {removing ? "Removing…" : "Remove"}
          </Button>
        </span>
      }
    />
  );
}

/** How messages travel, in the dialog's words, and the health that matters for that way. */
function PeerStatus({ peer }: { readonly peer: PeerRecord }) {
  // Re-rendered each minute, so "online" turns to "offline since" between the list's refreshes.
  // The minute only triggers the render: it is up to 59 s behind, and the online
  // window is measured against the real time, as the CLI measures it.
  useNowMinute();
  const state = peerPollState(peer, Date.now());
  const travel =
    peer.linkMode === "store"
      ? "Polls this server for its A2A messages"
      : peer.linkMode === "poll"
        ? `${peer.origin ?? ""} · this server polls it for A2A messages`
        : `${peer.origin ?? ""} · sends directly both ways`;
  const rejected = isPeerCredentialRejected(peer);
  // Once polling stopped, the last poll that worked says nothing about the peer.
  const stoppedReason = peerPollStoppedReason(peer);
  const stopped = stoppedReason !== null;
  const health = rejected
    ? `Polling stopped · ${peer.label} rejected the credential`
    : stopped
      ? "Polling stopped"
      : state === null
        ? peer.inboundSession === "active"
          ? "Session active"
          : "No live session here: its deliveries are refused"
        : state.kind === "never"
          ? peer.linkMode === "store"
            ? "Has not polled yet"
            : "Not polled yet"
          : state.kind === "online"
            ? `Online · last polled ${formatRelativeTimeLabel(state.lastPolledAt)}`
            : `Offline since ${formatRelativeTimeLabel(state.since)}`;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{travel}</span>
      <span className={stopped ? "text-destructive" : undefined}>
        {health}
        {peer.waitingCount > 0 && peer.oldestWaitingAt !== null
          ? ` · ${String(peer.waitingCount)} waiting · oldest ${formatRelativeTimeLabel(peer.oldestWaitingAt)}`
          : peer.linkMode === "store"
            ? " · 0 waiting"
            : ""}
      </span>
      {rejected ? (
        <span>Peer again to issue a new one.</span>
      ) : peer.lastError !== null ? (
        <span className="text-destructive">{stoppedReason ?? peer.lastError}</span>
      ) : null}
    </span>
  );
}
