import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { addedEnvironmentAtom, noteEnvironmentAdded } from "./addedEnvironment";
import { LinkServersDialog } from "./LinkServersDialog";
import { linkCandidatesFor, type ManagedLinks } from "./managedLinks";

/**
 * Offers to link a server straight after it is added: once it has connected and this client can
 * manage access on it and on another server it is not linked with, the link dialog opens for it
 * with every such server ticked. A server that never gets there is never offered.
 */
export function AddedEnvironmentLinkOffer({ links }: { readonly links: ManagedLinks }) {
  const addedId = useAtomValue(addedEnvironmentAtom);
  // Linking makes its servers "already linked", so what was offered is kept from when it opened.
  const [offer, setOffer] = useState<{
    readonly environmentId: EnvironmentId;
    readonly others: ReadonlyArray<EnvironmentId>;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the offer belongs to the visit that added the server: arriving and leaving both drop it, so an add that finished after the page closed cannot open one on a later visit
  useEffect(() => {
    noteEnvironmentAdded(null);
    return () => void noteEnvironmentAdded(null);
  }, []);
  if (addedId === null) return null;

  if (offer?.environmentId !== addedId) {
    if (!links.servers.includes(addedId)) return null;
    const others = linkCandidatesFor(links, addedId)
      .candidates.filter((candidate) => candidate.unavailable === null)
      .map((candidate) => candidate.environmentId);
    if (others.length === 0) return null;
    setOffer({ environmentId: addedId, others });
    return null;
  }

  return (
    <LinkServersDialog
      key={offer.environmentId}
      open
      onOpenChange={(open) => {
        if (open) return;
        noteEnvironmentAdded(null);
        setOffer(null);
      }}
      links={links}
      defaultServerId={offer.environmentId}
      initialOtherIds={offer.others}
      offer
    />
  );
}
