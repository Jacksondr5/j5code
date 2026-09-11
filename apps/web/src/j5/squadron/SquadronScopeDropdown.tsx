import { scopedSquadronKey } from "@t3tools/contracts/j5";
import { PlusIcon, RadioIcon } from "lucide-react";
import { useState } from "react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import { useSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronScope, useSquadronAmbientScope } from "./SquadronDraftState";
import { SquadronCreateDialog } from "./SquadronCreateDialog";
import { resolveSquadronScope } from "./SquadronScope.logic";

/** Sidebar-zone-only ambient context. It never selects a Squadron for a draft. */
type SquadronScopeDropdownProps =
  | {
      readonly createOpen: boolean;
      readonly onCreateOpenChange: (open: boolean) => void;
    }
  | {
      readonly createOpen?: never;
      readonly onCreateOpenChange?: never;
    };

function hasControlledCreateState(
  props: SquadronScopeDropdownProps,
): props is Extract<SquadronScopeDropdownProps, { readonly createOpen: boolean }> {
  return "createOpen" in props;
}

export function SquadronScopeDropdown(props: SquadronScopeDropdownProps = {}) {
  const [uncontrolledCreateOpen, setUncontrolledCreateOpen] = useState(false);
  const createOpen = hasControlledCreateState(props) ? props.createOpen : uncontrolledCreateOpen;
  const setCreateOpen = hasControlledCreateState(props)
    ? props.onCreateOpenChange
    : setUncontrolledCreateOpen;
  const { status, squadrons, sources } = useSquadronDirectory();
  const selectedId = useSquadronAmbientScope();
  const choices = squadrons.map(({ squadron, environmentId, environmentLabel }) => ({
    environmentId,
    environmentLabel,
    id: squadron.id,
    name: squadron.name,
  }));
  const selected = resolveSquadronScope(choices, selectedId);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton
              aria-label="Set ambient Squadron scope"
              className="min-w-0 flex-1 ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            />
          }
        >
          <RadioIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {status === "loading" ? "Loading Squadrons…" : (selected?.name ?? "Squadron scope")}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" className="w-(--anchor-width)">
          <MenuRadioGroup
            value={
              selected === null
                ? "none"
                : scopedSquadronKey({
                    environmentId: selected.environmentId,
                    squadronId: selected.id,
                  })
            }
            onValueChange={(value) => {
              const choice = choices.find(
                (choice) =>
                  scopedSquadronKey({
                    environmentId: choice.environmentId,
                    squadronId: choice.id,
                  }) === value,
              );
              setAmbientSquadronScope(
                choice === undefined
                  ? null
                  : { environmentId: choice.environmentId, squadronId: choice.id },
              );
            }}
          >
            <MenuRadioItem value="none" closeOnClick>
              All Squadrons
            </MenuRadioItem>
            {choices.map((choice) => (
              <MenuRadioItem
                key={scopedSquadronKey({
                  environmentId: choice.environmentId,
                  squadronId: choice.id,
                })}
                value={scopedSquadronKey({
                  environmentId: choice.environmentId,
                  squadronId: choice.id,
                })}
                closeOnClick
              >
                <span className="min-w-0 truncate">
                  {choice.name}
                  <span className="ms-2 text-xs text-muted-foreground">
                    {choice.environmentLabel}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {sources
            .filter((source) => source.status !== "ready")
            .map((source) => (
              <p key={source.environmentId} className="px-3 py-1 text-xs text-muted-foreground">
                {source.environmentLabel}:{" "}
                {source.status === "loading"
                  ? "Loading…"
                  : source.status === "unsupported"
                    ? "Squadrons unavailable"
                    : source.status === "offline"
                      ? "Offline"
                      : "Could not refresh Squadrons"}
              </p>
            ))}
          <MenuSeparator />
          <MenuItem onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            Create Squadron…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <SquadronCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
