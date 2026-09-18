import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalSeat, CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { useState } from "react";

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
import { CUSTOM_AGENT } from "./crewProposalDraft";
import { CrewSeatEditor } from "./CrewSeatEditor";
import { crewSeatDraft, resolvedCustomDraft, type CrewSeatDraft } from "./crewSeatRuntime";

/** Local drafts are published only by Save/Add; closing the dialog leaves approval unchanged. */
export function CrewSeatDialog(props: {
  readonly seat: CrewProposalSeat | null;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly agents: ReadonlyArray<{ readonly personaId: string; readonly displayName: string }>;
  readonly disabled: boolean;
  readonly onSave: (draft: CrewSeatDraft) => string | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<CrewSeatDraft>(() => {
    if (props.seat === null) return { seat: "", agentId: CUSTOM_AGENT, instructions: "" };
    const initial = crewSeatDraft(props.seat);
    return props.seat.agentId === null ? resolvedCustomDraft(initial, props.runtime) : initial;
  });
  const [error, setError] = useState<string | null>(null);
  const matchingRuntime =
    props.seat !== null &&
    draft.agentId === (props.seat.agentId ?? CUSTOM_AGENT) &&
    (draft.agentId !== CUSTOM_AGENT ||
      JSON.stringify(draft.modelSelection) === JSON.stringify(props.runtime?.modelSelection))
      ? props.runtime
      : undefined;
  const adding = props.seat === null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.disabled) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl" showCloseButton={!props.disabled}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.disabled) return;
            const nextError = props.onSave(draft);
            setError(nextError);
            if (nextError === null) props.onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{adding ? "Add crew member" : `Edit ${props.seat!.seat}`}</DialogTitle>
            <DialogDescription>
              {adding
                ? "Choose a saved persona or configure a custom crew member."
                : "Update this member’s instructions and runtime settings."}{" "}
              Runtime settings are checked before you approve the crew.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <CrewSeatEditor
              value={draft}
              environmentId={props.environmentId}
              agents={props.agents}
              runtime={matchingRuntime}
              disabled={props.disabled}
              existing={!adding}
              onChange={setDraft}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={props.disabled}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.disabled}>
              {adding ? "Add member" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
