import { RadioIcon } from "lucide-react";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import { useSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronId, useSquadronAmbientScope } from "./SquadronDraftState";
import { resolveSquadronScope } from "./SquadronScope.logic";

/** Sidebar-zone-only ambient context. It never selects a Squadron for a draft. */
export function SquadronScopeDropdown() {
  const { status, squadrons } = useSquadronDirectory();
  const selectedId = useSquadronAmbientScope();
  const choices = squadrons.map(({ squadron }) => ({ id: squadron.id, name: squadron.name }));
  const selected = resolveSquadronScope(choices, selectedId);

  return (
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
      </MenuPopup>
    </Menu>
  );
}
