import { RadioIcon } from "lucide-react";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Button } from "../../components/ui/button";
import { useSquadronDirectory } from "./SquadronDirectory";
import { selectDraftSquadron, useSquadronDraftScope } from "./SquadronDraftState";
import { type DurableSquadronHome, resolveSquadronScope } from "./SquadronScope.logic";

/** The only draft-local mutable Squadron control; its owner freezes it at first send. */
export function SquadronDraftChip({
  draftKey,
  ambientSquadronId,
  durableHome,
  frozen,
}: {
  readonly draftKey: string;
  readonly ambientSquadronId: string | null;
  readonly durableHome: DurableSquadronHome | null;
  readonly frozen: boolean;
}) {
  const { status, squadrons } = useSquadronDirectory();
  const draft = useSquadronDraftScope(draftKey);
  const choices = squadrons.map(({ squadron }) => ({
    id: squadron.id,
    name: squadron.name,
  }));
  const selected =
    durableHome ?? resolveSquadronScope(choices, draft.squadronId ?? ambientSquadronId);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label="Choose Squadron for this draft"
            className="h-7 max-w-56 gap-1.5 px-2 text-xs"
            disabled={frozen || status !== "ready"}
            size="sm"
            type="button"
            variant="ghost-muted"
          />
        }
      >
        <RadioIcon className="size-3.5" />
        <span className="truncate">
          {frozen ? (selected?.name ?? "Squadron frozen") : (selected?.name ?? "Choose Squadron")}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52">
        <MenuRadioGroup
          value={selected?.id ?? ""}
          onValueChange={(value) => {
            if (!frozen) selectDraftSquadron(draftKey, String(value));
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
              {choice.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
