import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { peersQueryAtom } from "../state";
import { PeerIntroductionDialog } from "./PeerIntroductionDialog";
import { refreshPeers, removePeer, type PeerRecord } from "./peeringClient";

/**
 * The servers this environment exchanges agent messages with. A peer is also
 * an authorized session in the list above; this section is where the pairing
 * is made and where this server's own record of the peer is removed.
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const remove = useCallback(
    async (peer: PeerRecord) => {
      if (primaryEnvironmentId === null) return;
      const confirmed = await (requestConfirmDialog(
        `Remove ${peer.label} as a peer? Agents on the two servers will no longer be able to message each other, and the credential ${peer.label} holds for this server is revoked.`,
        { variant: "destructive" },
        { confirmLabel: "Remove peer" },
      ) ?? Promise.resolve(true));
      if (!confirmed) return;
      setRemoving(peer.environmentId);
      try {
        await removePeer(primaryEnvironmentId, peer.environmentId);
        refreshPeers(primaryEnvironmentId);
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not remove the peer",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setRemoving(null);
      }
    },
    [primaryEnvironmentId],
  );

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
          aria-label="Peer with another environment"
          onClick={() => setDialogOpen(true)}
        >
          <PlusIcon className="size-3" />
          <span>Peer with…</span>
        </Button>
      }
    >
      {(peers.data ?? []).map((peer) => (
        <SettingsRow
          key={peer.environmentId}
          title={peer.label}
          description={`${peer.origin} · ${peer.environmentId}`}
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={removing === peer.environmentId}
              onClick={() => void remove(peer)}
            >
              {removing === peer.environmentId ? "Removing…" : "Remove"}
            </Button>
          }
        />
      ))}
      {peers.data !== null && peers.data.length === 0 ? (
        <SettingsRow
          title="No peers yet"
          description="Peer this server with another environment you are connected to so their agents can exchange messages. Agents address each other by participant id; which server a Squadron lives on stays the platform's business."
        />
      ) : null}
      {peers.error !== null ? (
        <SettingsRow title="Couldn't read peers" description={peers.error} />
      ) : null}
      <PeerIntroductionDialog
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
