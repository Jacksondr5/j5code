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
      await deleteSquadron(target.environmentId, { squadronId: target.id, force: true });
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
            This permanently deletes every agent thread in this Squadron, including archived ones
            and Crew seats, and stops any running work. The Squadron’s message history is deleted
            with it. Files on disk are not touched. This cannot be undone.
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
          {/* A failure stays retryable: the server resumes where a partial delete stopped. */}
          <Button disabled={submitting} variant="destructive" onClick={() => void confirm()}>
            {submitting ? "Deleting…" : "Delete Squadron"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
