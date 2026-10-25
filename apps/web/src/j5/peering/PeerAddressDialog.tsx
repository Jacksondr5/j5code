import type { EnvironmentId } from "@t3tools/contracts";
import { PeerOrigin } from "@t3tools/contracts/j5";
import type { PeeringReach } from "@t3tools/client-runtime/j5/peering";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { OriginField } from "./PeerIntroductionDialog";
import { runReachCheck } from "./peeringCheck";
import { changePeerOrigin, refreshPeers, type PeerRecord } from "./peeringClient";

const isPeerOrigin = Schema.is(PeerOrigin);

/**
 * Moves the address one server reaches its peer at, keeping the credential it holds: the server
 * proves the new address answers as the same peer before it records it, so nothing waiting is
 * cancelled. The check offers where the holder reaches the peer now, from the peer's own
 * addresses and the one this client uses for it.
 */
export function PeerAddressDialog({
  open,
  onOpenChange,
  holder,
  peer,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly holder: { readonly environmentId: EnvironmentId; readonly label: string };
  /** The holder's record of the peer. */
  readonly peer: PeerRecord;
}) {
  const peerId = peer.environmentId as EnvironmentId;
  const peerBaseUrl = useEnvironmentHttpBaseUrl(peerId);
  const [reach, setReach] = useState<PeeringReach | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void runReachCheck(holder.environmentId, {
      server: { environmentId: peerId, label: peer.label },
      clientUrl: peerBaseUrl,
    }).then((result) => {
      if (!cancelled) setReach(result);
    });
    return () => {
      cancelled = true;
    };
  }, [holder.environmentId, peerId, peer.label, peerBaseUrl]);

  // The address the check proved fills the field until the person types their own.
  const value = origin ?? (reach?.kind === "reached" ? reach.origin : "");
  const trimmed = value.trim().replace(/\/+$/, "");
  const ready = isPeerOrigin(trimmed) && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await changePeerOrigin(holder.environmentId, peer.environmentId, trimmed);
      refreshPeers(holder.environmentId);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change {peer.label}'s address</DialogTitle>
          <DialogDescription>
            {holder.label} keeps the credential it holds for {peer.label}, so messages waiting and
            open Exchanges carry on. The new address is used only once {peer.label} answers there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {holder.label} reaches {peer.label} at {peer.origin ?? "no address"} now.
            </p>
            <ReachCard holder={holder.label} peer={peer.label} reach={reach} />
            <OriginField
              title={`${holder.label} reaches ${peer.label} at`}
              value={value}
              onChange={setOrigin}
              disabled={busy}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={() => void save()}>
            {busy ? "Changing…" : "Change address"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReachCard({
  holder,
  peer,
  reach,
}: {
  readonly holder: string;
  readonly peer: string;
  readonly reach: PeeringReach | null;
}) {
  if (reach === null) {
    return (
      <Alert>
        <AlertTitle>
          Checking where {holder} reaches {peer}…
        </AlertTitle>
      </Alert>
    );
  }
  switch (reach.kind) {
    case "reached":
      return (
        <Alert variant="success">
          <AlertTitle>
            {holder} reaches {peer} at {reach.origin}
          </AlertTitle>
        </Alert>
      );
    case "failed":
      return (
        <Alert variant="warning">
          <AlertTitle>
            {holder} couldn't reach {peer} at the addresses it tried
          </AlertTitle>
          <AlertDescription>
            {reach.errors.map((line) => (
              <span key={line} className="block font-mono text-xs">
                {line}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      );
    case "untested":
      return (
        <Alert>
          <AlertTitle>
            Enter the address {holder} can reach {peer} at
          </AlertTitle>
          <AlertDescription>
            {reach.error === null
              ? `${peer} only knows loopback addresses for itself.`
              : `${peer} could not list its addresses: ${reach.error}`}
          </AlertDescription>
        </Alert>
      );
  }
}
