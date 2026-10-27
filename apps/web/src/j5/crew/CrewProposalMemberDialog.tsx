import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewWorkspaceOptions } from "@t3tools/contracts/j5";
import { useEffect, useEffectEvent, useMemo, useState, type RefObject } from "react";

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
import { useAtomCommand } from "../../state/use-atom-command";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import {
  CUSTOM_AGENT,
  crewMemberInstructions,
  crewProposalRoster,
  type CrewProposalRow,
} from "./crewProposalDraft";
import { CrewSeatEditor } from "./CrewSeatEditor";
import { chooseCrewSeatPersona, type CrewSeatDraft } from "./crewSeatRuntime";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

export function CrewProposalMemberDialog(props: {
  row: CrewProposalRow;
  returnFocus: RefObject<HTMLButtonElement | null>;
  rows: ReadonlyArray<CrewProposalRow>;
  proposalId: string;
  previewSeatName: string;
  environmentId: EnvironmentId | null;
  workspaceOptions?: CrewWorkspaceOptions | undefined;
  agents: ReadonlyArray<{ personaId: string; displayName: string }>;
  disabled: boolean;
  onClose: () => void;
  onSave: (value: CrewSeatDraft) => void;
}) {
  const [value, setValue] = useState(props.row.value);
  const [personaInstructions, setPersonaInstructions] = useState<string | null>(null);
  const [loadedPersona, setLoadedPersona] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, { reportFailure: false });
  const personaId = value.agentId;
  const custom = personaId === CUSTOM_AGENT;
  const loadingPersona = !custom && loadedPersona !== personaId;
  const initialInstructions = useEffectEvent(() => value.instructions);

  useEffect(() => {
    if (custom || props.environmentId === null || personaError !== null) return;
    let current = true;
    const extra = initialInstructions();
    void read({ environmentId: props.environmentId, input: { personaId } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setPersonaError(cause instanceof Error ? cause.message : "Could not load persona.");
          return;
        }
        const instructions = result.value.definition.instructions;
        setPersonaInstructions(instructions);
        setValue((draft) => ({
          ...draft,
          instructions: extra ? `${instructions}\n\n${extra}` : instructions,
        }));
        setLoadedPersona(personaId);
        setPersonaError(null);
      },
      (cause: unknown) => {
        if (current)
          setPersonaError(cause instanceof Error ? cause.message : "Could not load persona.");
      },
    );
    return () => {
      current = false;
    };
  }, [custom, personaId, props.environmentId, read, personaError]);

  const instructions = crewMemberInstructions(value.instructions, personaInstructions);
  const saved = { ...value, instructions };
  const roster = crewProposalRoster([
    ...props.rows.filter((row) => row.id !== props.row.id),
    { ...props.row, value: saved },
  ]);
  const error = roster.errors.get(props.row.id);
  // Runtime defaults can be repaired independently of invalid names, instructions, or workspaces.
  // Only the card's complete roster preview can authorize approval.
  const seats = useMemo(
    () => [
      {
        seat: props.previewSeatName,
        agentId: custom ? null : personaId,
        reason: "Member runtime preview",
        workspace: { type: "shared" as const },
        ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
        ...(value.runtimeMode ? { runtimeMode: value.runtimeMode } : {}),
        ...(custom ? { instructions: "Crew member" } : {}),
      },
    ],
    [props.previewSeatName, custom, personaId, value.modelSelection, value.runtimeMode],
  );
  const preview = useCrewProposalPreview(
    props.environmentId,
    props.proposalId,
    seats,
    props.disabled,
  );
  const runtime = preview.runtimeSeats?.[0];
  const blocked = props.disabled || loadingPersona || personaError !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup finalFocus={props.returnFocus}>
        <DialogHeader>
          <DialogTitle>{props.row.original === null ? "Add member" : "Edit member"}</DialogTitle>
          <DialogDescription>
            Changes apply to the proposal. Nobody starts until you approve the Crew.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <CrewSeatEditor
            value={value}
            environmentId={props.environmentId}
            agents={props.agents}
            runtime={runtime}
            workspaceOptions={props.workspaceOptions ?? preview.workspaceOptions}
            disabled={props.disabled}
            loadingInstructions={loadingPersona}
            onChange={setValue}
            onMenuOpenChange={() => undefined}
            onPersonaChange={(agentId) => {
              setPersonaInstructions(null);
              setLoadedPersona(null);
              setPersonaError(null);
              const agent = props.agents.find((agent) => agent.personaId === agentId);
              setValue((draft) => ({
                ...chooseCrewSeatPersona(draft, agentId),
                ...(agent ? { seat: agent.displayName, instructions: "" } : {}),
              }));
            }}
          />
          {loadingPersona && !personaError ? (
            <p className="mt-3 text-xs text-muted-foreground" role="status">
              Loading persona instructions…
            </p>
          ) : null}
          {personaError ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-destructive" role="alert">
                {personaError}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPersonaError(null);
                }}
              >
                Retry persona
              </Button>
            </div>
          ) : null}
          {error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {preview.error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {preview.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={blocked || error !== undefined || runtime === undefined}
            onClick={() => props.onSave(saved)}
          >
            {props.row.original === null ? "Add member" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
