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
import { refreshAfterSquadronChange } from "./refreshAfterSquadronChange";

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
  // Held here so Escape or an outside click cannot unmount the form mid-request.
  const [submitting, setSubmitting] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
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
          submitting={submitting}
          onSubmittingChange={setSubmitting}
          onRenamed={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function SquadronRenameForm({
  onRenamed,
  onSubmittingChange: setSubmitting,
  submitting,
  target,
}: {
  readonly onRenamed: () => void;
  readonly onSubmittingChange: (submitting: boolean) => void;
  readonly submitting: boolean;
  readonly target: SquadronActionTarget;
}) {
  const [name, setName] = useState(target.name);
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
      await refreshAfterSquadronChange(target.environmentId);
      onRenamed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename the Squadron.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // The popup lays out header, panel, and footer as a flex column; an element between them
    // must be one too, or the scroll panel overflows and pushes the footer outside the popup.
    <form
      className="flex min-h-0 flex-col"
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
