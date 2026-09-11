import type { DraftId } from "../../composerDraftStore";
import { useProjects } from "../../state/entities";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { retargetSquadronDraft } from "./retargetSquadronDraft";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ScopedSquadronRef } from "@t3tools/contracts/j5";
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
import { type DurableSquadronHome } from "./SquadronScope.logic";

/** The only draft-local mutable Squadron control; its owner freezes it at first send. */
export function SquadronDraftChip({
  draftKey,
  draftId,
  environmentId,
  ambientSquadronScope,
  durableHome,
  frozen,
}: {
  readonly draftKey: string;
  readonly draftId: DraftId | null;
  readonly environmentId: EnvironmentId;
  readonly ambientSquadronScope: ScopedSquadronRef | null;
  readonly durableHome: DurableSquadronHome | null;
  readonly frozen: boolean;
}) {
  const { sources, squadrons } = useSquadronDirectory();
  const draft = useSquadronDraftScope(draftKey);
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const source = sources.find((source) => source.environmentId === environmentId);
  const choices = squadrons
    .filter((entry) => entry.environmentId === environmentId)
    .map(({ squadron, projectIds }) => ({
      id: squadron.id,
      name: squadron.name,
      project:
        projects.find(
          (project) => project.environmentId === environmentId && project.id === projectIds[0],
        ) ?? null,
    }));
  const selectedId =
    draft.squadronId ??
    (ambientSquadronScope?.environmentId === environmentId
      ? ambientSquadronScope.squadronId
      : null);
  const selected = durableHome ?? choices.find((choice) => choice.id === selectedId);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label="Choose Squadron for this draft"
            className="h-7 max-w-56 gap-1.5 px-2 text-xs"
            disabled={frozen || source?.status !== "ready" || !source.canOperate}
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
            if (frozen) return;
            const choice = choices.find((choice) => choice.id === value);
            if (!choice?.project) return;
            if (draftId !== null) {
              retargetSquadronDraft({
                draftId,
                squadronId: choice.id,
                project: choice.project,
                groupingSettings,
              });
            } else {
              selectDraftSquadron(draftKey, choice.id);
            }
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem
              key={choice.id}
              value={choice.id}
              disabled={choice.project === null}
              closeOnClick
            >
              {choice.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
