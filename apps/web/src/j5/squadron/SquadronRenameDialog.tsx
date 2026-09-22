import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { resolveSquadronRenameState } from "./SquadronActions.logic";
import { renameSquadron } from "./squadronClient";
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { refreshRequestedThreadHomes } from "./ThreadHomesClient";
import { refreshFleet } from "../fleet/fleetClient";

export interface SquadronActionTarget {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly name: string;
}

/** Rename is its own undo: the id stays, so only the name every surface shows changes. */
export function SquadronRenameDialog({
  onOpenChange,
  open,
  target,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly target: SquadronActionTarget;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename Squadron</DialogTitle>
          <DialogDescription>
            Every home, membership, Crew, and thread label follows the new name.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed so reopening for another Squadron starts from that Squadron's name. */}
        <SquadronRenameForm
          key={`${target.environmentId}:${target.id}`}
          target={target}
          onRenamed={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function SquadronRenameForm({
  onRenamed,
  target,
}: {
  readonly onRenamed: () => void;
  readonly target: SquadronActionTarget;
}) {
  const [name, setName] = useState(target.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameState = resolveSquadronRenameState({ draftName: name, currentName: target.name });

  const submit = async () => {
    if (renameState.kind !== "ready") return;
    setSubmitting(true);
    setError(null);
    try {
      await renameSquadron(target.environmentId, {
        squadronId: target.id,
        name: renameState.name,
      });
      await refreshSquadronDirectory({ environmentId: target.environmentId, force: true });
      refreshRequestedThreadHomes();
      void refreshFleet();
      onRenamed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename the Squadron.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogPanel className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
          Squadron name
          <Input
            nativeInput
            autoFocus
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        {renameState.kind === "missing-name" ? (
          <p className="text-sm text-destructive">{renameState.message}</p>
        ) : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose disabled={submitting} render={<Button variant="outline" />}>
          Cancel
        </DialogClose>
        <Button disabled={submitting || renameState.kind !== "ready"} type="submit">
          {submitting ? "Renaming…" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}
