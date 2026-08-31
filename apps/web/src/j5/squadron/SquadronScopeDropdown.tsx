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
import { setAmbientSquadronId, useSquadronAmbientScope } from "./SquadronDraftState";
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
  const { status, squadrons } = useSquadronDirectory();
  const selectedId = useSquadronAmbientScope();
  const choices = squadrons.map(({ squadron, projectIds }) => ({
    id: squadron.id,
    name: squadron.name,
    projectIds,
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
            value={selected?.id ?? "none"}
            onValueChange={(value) => setAmbientSquadronId(value === "none" ? null : String(value))}
          >
            <MenuRadioItem value="none" closeOnClick>
              No ambient Squadron
            </MenuRadioItem>
            {choices.map((choice) => (
              <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                {choice.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
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
