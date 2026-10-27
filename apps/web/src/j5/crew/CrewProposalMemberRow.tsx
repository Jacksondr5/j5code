import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime, CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { PencilIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { serverEnvironment } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { CrewSeatEditor } from "./CrewSeatEditor";
import {
  CUSTOM_AGENT,
  crewProposalRowChange,
  describeSeatAgent,
  type CrewProposalRow,
} from "./crewProposalDraft";
import {
  crewSeatStopsForApprovals,
  describeCrewSeatWorkspace,
  type CrewSeatDraft,
} from "./crewSeatRuntime";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

function MemberProvider(props: {
  environmentId: EnvironmentId;
  runtime?: CrewProposalSeatRuntime | undefined;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const entry = deriveProviderInstanceEntries(providers).find(
    (provider) => provider.instanceId === props.runtime?.modelSelection.instanceId,
  );
  return entry ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={entry.displayName}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          iconClassName="size-4"
        />
      </TooltipTrigger>
      <TooltipPopup>{entry.displayName}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className="size-4 shrink-0" aria-hidden />
  );
}

export function CrewProposalMemberRow(props: {
  readonly row: CrewProposalRow;
  readonly proposalId: string;
  readonly previewSeatName: string;
  readonly environmentId: EnvironmentId | null;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  readonly workspaceOptions?: CrewWorkspaceOptions | undefined;
  readonly agents: ReadonlyArray<{ readonly personaId: string; readonly displayName: string }>;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly canRemove: boolean;
  readonly needsRuntimePreview: boolean;
  readonly runtimeLoading: boolean;
  readonly error?: string | undefined;
  readonly children?: ReactNode;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onRemove: () => void;
  readonly onChange: (draft: CrewSeatDraft) => void;
}) {
  const { row, open, onClose } = props;
  const eventsInside = useRef(new WeakSet<Event>());
  const editButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const previewSeats = useMemo(
    () => [
      {
        seat: props.previewSeatName,
        agentId: row.value.agentId === CUSTOM_AGENT ? null : row.value.agentId,
        reason: "Member runtime preview",
        workspace: { type: "shared" as const },
        ...(row.value.modelSelection ? { modelSelection: row.value.modelSelection } : {}),
        ...(row.value.runtimeMode ? { runtimeMode: row.value.runtimeMode } : {}),
        ...(row.value.agentId === CUSTOM_AGENT ? { instructions: "Crew member" } : {}),
      },
    ],
    [props.previewSeatName, row.value.agentId, row.value.modelSelection, row.value.runtimeMode],
  );
  // The shared checkout lets a member repair a bad workspace even when its roster preview fails.
  // This token never authorizes the roster; only the card's complete, current preview can do that.
  const defaults = useCrewProposalPreview(
    props.environmentId,
    props.proposalId,
    previewSeats,
    props.disabled ||
      !props.open ||
      ((!props.needsRuntimePreview || props.runtime !== undefined) &&
        props.workspaceOptions !== undefined),
  );
  const runtime = props.runtime ?? defaults.runtimeSeats?.[0];
  const change = crewProposalRowChange(row);
  const seat = {
    agentId: row.value.agentId === CUSTOM_AGENT ? null : row.value.agentId,
    runtimeMode: row.value.runtimeMode,
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      // React capture includes portalled pickers; DOM containment would close the row on a pick.
      if (!eventsInside.current.has(event)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, onClose]);

  return (
    <li
      className="group/member py-3"
      data-testid={`crew-member-${row.id}`}
      onPointerDownCapture={(event) => eventsInside.current.add(event.nativeEvent)}
      onFocusCapture={(event) => eventsInside.current.add(event.nativeEvent)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !menuOpen && !event.defaultPrevented) {
          event.preventDefault();
          props.onClose();
          editButton.current?.focus();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <div className="pt-1">
          {props.environmentId === null ? null : (
            <MemberProvider environmentId={props.environmentId} runtime={runtime} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {props.open ? (
            <CrewSeatEditor
              value={row.value}
              environmentId={props.environmentId}
              runtime={runtime}
              workspaceOptions={props.workspaceOptions ?? defaults.workspaceOptions}
              agents={props.agents}
              disabled={props.disabled}
              existing={row.original !== null}
              onChange={props.onChange}
              initialPersonaOpen={personaOpen}
              onMenuOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) setPersonaOpen(false);
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="break-words text-sm font-medium">
                  {props.open
                    ? row.value.seat || "New member"
                    : row.value.seat.trim().toLowerCase().replace(/\s+/g, "-") || "New member"}
                </h3>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  disabled={props.disabled}
                  onClick={() => {
                    setPersonaOpen(true);
                    props.onOpen();
                  }}
                  aria-label={`Change persona for ${row.value.seat || "new member"}`}
                >
                  {describeSeatAgent(props.agents, seat.agentId)}
                </Button>
              </div>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">
                {runtime
                  ? [
                      runtime.model,
                      runtime.reasoning,
                      runtime.access,
                      describeCrewSeatWorkspace(
                        props.runtime?.workspace ??
                          row.value.workspace ??
                          runtime.workspace ?? { type: "shared" },
                      ),
                    ].join(" · ")
                  : props.runtimeLoading || defaults.loading
                    ? "Resolving runtime…"
                    : "Runtime unavailable"}
              </p>
              {row.value.instructions ? (
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Instructions</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{row.value.instructions}</p>
                </details>
              ) : null}
            </>
          )}
          {change ? <span className="text-xs text-muted-foreground">{change}</span> : null}
          {crewSeatStopsForApprovals(seat, runtime) ? (
            <p className="mt-1 text-xs text-warning">Asks for approvals</p>
          ) : null}
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Why this member</summary>
            <p className="mt-1 whitespace-pre-wrap break-words">
              {row.original?.reason ?? "Added by the user"}
            </p>
          </details>
          {props.children}
          {props.error ? (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {props.error}
            </p>
          ) : null}
          {props.open && defaults.error && props.runtime === undefined ? (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {defaults.error}
            </p>
          ) : null}
          {props.open ? (
            <div className="mt-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={props.disabled}
                onClick={() => {
                  props.onClose();
                  editButton.current?.focus();
                }}
              >
                Done
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/member:opacity-100 group-focus-within/member:opacity-100">
          <Button
            ref={editButton}
            aria-label={`Edit seat ${row.value.seat || "new member"}`}
            type="button"
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={props.onOpen}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Remove seat ${row.value.seat || "new member"}`}
            type="button"
            size="xs"
            variant="ghost"
            disabled={props.disabled || !props.canRemove}
            onClick={props.onRemove}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}
