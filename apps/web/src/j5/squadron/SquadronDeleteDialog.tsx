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
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { forgetDeletedSquadron } from "./SquadronDraftState";
import type { SquadronActionTarget } from "./SquadronRenameDialog";
import { refreshRequestedThreadHomes } from "./ThreadHomesClient";
import { refreshFleet } from "../fleet/fleetClient";

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
      await refreshSquadronDirectory({ environmentId: target.environmentId, force: true });
      refreshRequestedThreadHomes();
      void refreshFleet();
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
            their Squadron home and appear only under All Squadrons. A Squadron with live members or
            Crews cannot be deleted; stop or archive them first. This cannot be undone.
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
          <Button
            disabled={submitting || failure?.kind === "refused"}
            variant="destructive"
            onClick={() => void confirm()}
          >
            {submitting ? "Deleting…" : "Delete Squadron"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
