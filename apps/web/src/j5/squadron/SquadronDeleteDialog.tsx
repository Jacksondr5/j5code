import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { describeSquadronDeleteFailure } from "./SquadronActions.logic";
import { deleteSquadron } from "./squadronClient";
import { forgetDeletedSquadron } from "./SquadronDraftState";
import type { SquadronActionTarget } from "./SquadronRenameDialog";
import { refreshAfterSquadronChange } from "./refreshAfterSquadronChange";

/** Delete has no undo, so it names the Squadron and states what happens before asking. */
export function SquadronDeleteDialog({
  onOpenChange,
  open,
  target,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly target: SquadronActionTarget;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeSquadronDeleteFailure> | null>(
    null,
  );

  const confirm = async () => {
    setSubmitting(true);
    setFailure(null);
    try {
      await deleteSquadron(target.environmentId, { squadronId: target.id });
      forgetDeletedSquadron({ environmentId: target.environmentId, squadronId: target.id });
      await refreshAfterSquadronChange(target.environmentId);
      onOpenChange(false);
    } catch (cause) {
      setFailure(describeSquadronDeleteFailure(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setFailure(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{target.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents that called this Squadron home keep their threads, but their thread labels lose
            their Squadron home and appear only under All Squadrons. The Squadron’s message history
            is deleted with it. A Squadron with unarchived agents or Crews cannot be deleted;
            archive them first. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure !== null ? (
          <p className="px-6 pb-4 text-sm text-destructive" role="alert">
            {failure.message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose disabled={submitting} render={<Button variant="outline" />}>
            Cancel
          </AlertDialogClose>
          {/* A refusal stays retryable: the blockers may be archived elsewhere meanwhile. */}
          <Button disabled={submitting} variant="destructive" onClick={() => void confirm()}>
            {submitting ? "Deleting…" : "Delete Squadron"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
