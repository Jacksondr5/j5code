import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
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

  // Peering is an administrative act on this server, like pairing links and sessions.
  if (primaryEnvironmentId === null || !canManage) return null;

  return (
    <SettingsSection
      title="Peer servers"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          className="font-normal text-muted-foreground/60 hover:text-muted-foreground"
          aria-label="Add peer"
          onClick={() => {
            setDialogGeneration((generation) => generation + 1);
            setDialogOpen(true);
          }}
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
          description="Peer this server with another environment you are connected to so their agents can exchange messages. Agents address each other by participant id and never see which server the other is on."
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
  otherEnvironmentId,
}: {
  readonly peer: PeerRecord;
  readonly primaryEnvironmentId: EnvironmentId;
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
      description={`${peer.origin} · ${peer.environmentId}`}
      control={
        <Button size="sm" variant="ghost" disabled={removing} onClick={() => void remove()}>
          {removing ? "Removing…" : "Remove"}
        </Button>
      }
    />
  );
}
