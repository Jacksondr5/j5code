import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { SquadronCreateForm } from "./SquadronCreateForm";

/** Subsequent creation reuses the same explicit name-and-folder form as first run. */
export function SquadronCreateDialog({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create a Squadron</DialogTitle>
          <DialogDescription>
            Name this work and choose one existing folder. Your new agents will use the selected
            Squadron as their explicit home.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <SquadronCreateForm onCreated={() => onOpenChange(false)} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
