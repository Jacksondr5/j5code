import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import { scopedSquadronKey } from "@t3tools/contracts/j5";
import { PencilIcon, PlusIcon, RadioIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import { SidebarHeaderIconButton } from "../../components/sidebar/SidebarThreadHeader";
import { resolveSquadronActionsState } from "./SquadronActions.logic";
import { useSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronScope, useSquadronAmbientScope } from "./SquadronDraftState";
import { SquadronCreateDialog } from "./SquadronCreateDialog";
import { SquadronDeleteDialog } from "./SquadronDeleteDialog";
import { SquadronRenameDialog, type SquadronActionTarget } from "./SquadronRenameDialog";
import { resolveSquadronScope } from "./SquadronScope.logic";

/**
 * Sidebar-zone-only ambient context. It never selects a Squadron for a draft.
 * `header` renders the compact trigger for upstream's SidebarThreadHeader scope
 * slot: an icon while every Squadron is shown, plus the capped name once one is scoped.
 */
type SquadronScopeDropdownProps = { readonly variant?: "row" | "header" } & (
  | {
      readonly createOpen: boolean;
      readonly onCreateOpenChange: (open: boolean) => void;
    }
  | {
      readonly createOpen?: never;
      readonly onCreateOpenChange?: never;
    }
);

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
  // The dialogs keep their own target so a scope change mid-dialog cannot swap the Squadron.
  const [action, setAction] = useState<{
    readonly kind: "rename" | "delete";
    readonly target: SquadronActionTarget;
  } | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const { status, squadrons, sources } = useSquadronDirectory();
  const selectedId = useSquadronAmbientScope();
  const choices = squadrons.map(({ squadron, environmentId, environmentLabel, available }) => ({
    environmentId,
    environmentLabel,
    id: squadron.id,
    name: squadron.name,
    available,
  }));
  const showEnvironment = spansMultipleEnvironments(choices);
  const selected = resolveSquadronScope(choices, selectedId);
  const actionsState = resolveSquadronActionsState(selected);
  const openAction = (kind: "rename" | "delete") => {
    if (selected === null) return;
    setAction({
      kind,
      target: { environmentId: selected.environmentId, id: selected.id, name: selected.name },
    });
    setActionOpen(true);
  };

  return (
    <>
      <Menu>
        {props.variant === "header" ? (
          <MenuTrigger
            render={
              selected === null ? (
                <SidebarHeaderIconButton label="Squadron scope: All Squadrons" />
              ) : (
                // The sidebar's own 28px text size keeps the neighbours' height and hover; the
                // width cap leaves Search its label, and the tooltip carries the full name.
                <SidebarHeaderIconButton
                  label={`Squadron scope: ${selected.name}`}
                  size="sm"
                  className="w-auto max-w-22"
                />
              )
            }
          >
            <RadioIcon />
            {selected === null ? null : <span className="min-w-0 truncate">{selected.name}</span>}
          </MenuTrigger>
        ) : (
          <MenuTrigger
            render={
              <SidebarMenuButton
                aria-label="Set ambient Squadron scope"
                className="min-w-0 flex-1"
              />
            }
          >
            <RadioIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {status === "loading" ? "Loading Squadrons…" : (selected?.name ?? "Squadron scope")}
            </span>
          </MenuTrigger>
        )}
        <MenuPopup
          align="start"
          className={props.variant === "header" ? "min-w-56" : "w-(--anchor-width)"}
        >
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
                  {showEnvironment ? (
                    <>
                      {" "}
                      <span className="ms-1 text-xs text-muted-foreground">
                        {choice.environmentLabel}
                      </span>
                    </>
                  ) : null}
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
          {selected !== null && actionsState.kind !== "hidden" ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>
                  <span className="block truncate">{selected.name}</span>
                </MenuGroupLabel>
                <MenuItem
                  disabled={actionsState.kind === "disabled"}
                  onClick={() => openAction("rename")}
                >
                  <PencilIcon />
                  Rename Squadron…
                </MenuItem>
                <MenuItem
                  disabled={actionsState.kind === "disabled"}
                  variant="destructive"
                  onClick={() => openAction("delete")}
                >
                  <Trash2Icon />
                  Delete Squadron…
                </MenuItem>
                {actionsState.kind === "disabled" ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{actionsState.reason}</p>
                ) : null}
              </MenuGroup>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            Create Squadron…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <SquadronCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      {action?.kind === "rename" ? (
        <SquadronRenameDialog
          open={actionOpen}
          onOpenChange={setActionOpen}
          target={action.target}
        />
      ) : null}
      {action?.kind === "delete" ? (
        <SquadronDeleteDialog
          open={actionOpen}
          onOpenChange={setActionOpen}
          target={action.target}
        />
      ) : null}
    </>
  );
}
