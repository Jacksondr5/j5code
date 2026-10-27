import { useAtomValue } from "@effect/atom-react";
import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { useParticipantLabels } from "../a2a/ParticipantIdentitiesClient";
import { Button } from "../../components/ui/button";
import { j5Environment } from "../state";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import type { CrewProposal, CrewProposalSeat } from "./crewProposalsClient";
import { crewProposalRows, crewProposalRoster, newCrewProposalRow } from "./crewProposalDraft";
import { describePersonaSwap, removedSeatSteps, stepTitle, unownedSteps } from "./crewPlaybookPlan";
import { CrewProposalMemberDialog } from "./CrewProposalMemberDialog";
import type { CrewProposalRow } from "./crewProposalDraft";
import { CrewProposalMemberRow } from "./CrewProposalMemberRow";
import { useCrewProposalPreview } from "./useCrewProposalPreview";
import { useCanOperateThread } from "../sharing/access";

function CaptainLabel(props: { environmentId: EnvironmentId; participantId: string }) {
  const labels = useParticipantLabels(props.environmentId, [props.participantId]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        Captain: {labels.get(props.participantId) ?? props.participantId}
      </TooltipTrigger>
      <TooltipPopup>{props.participantId}</TooltipPopup>
    </Tooltip>
  );
}

export function CrewProposalCard(props: {
  readonly proposal: CrewProposal;
  readonly environmentId: EnvironmentId | null;
  readonly busy: boolean;
  readonly onResolve: (
    decision: "approve" | "decline",
    seats: ReadonlyArray<CrewProposalSeat>,
    approvalToken?: string,
  ) => void;
  readonly onOpenCaptain?: (() => void) | undefined;
}) {
  const { proposal } = props;
  const permitted = useAtomValue(
    j5Environment.resolveCrewProposal.permissionAtom(props.environmentId),
  );
  const writesToCaptain = useCanOperateThread(
    props.environmentId,
    proposal.captainThreadId as ThreadId,
  );
  const canResolve = permitted && writesToCaptain;
  const [rows, setRows] = useState(() => crewProposalRows(proposal.requestedSeats));
  const [editing, setEditing] = useState<CrewProposalRow | null>(null);
  const nextRow = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const [fullBrief, setFullBrief] = useState(false);
  const catalog = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const agents = useMemo(
    () =>
      catalog.data == null
        ? []
        : presentAgentPersonaCatalog(catalog.data).filter(
            (agent) => agent.availability === "available",
          ),
    [catalog.data],
  );
  const roster = useMemo(() => crewProposalRoster(rows), [rows]);
  const { seats, errors } = roster;
  const preview = useCrewProposalPreview(
    props.environmentId,
    proposal.id,
    seats,
    props.busy,
    errors.size === 0,
  );
  const playbook = preview.data?.playbook ?? proposal.playbook ?? null;
  const unowned =
    preview.data?.unownedSteps ?? (proposal.kind === "roster" ? unownedSteps(playbook, seats) : []);
  const titles = (ids: ReadonlyArray<string>) =>
    ids.map((id) => stepTitle(playbook, id)).join(", ");
  const canApprove =
    !props.busy &&
    canResolve &&
    editing === null &&
    rows.length > 0 &&
    errors.size === 0 &&
    preview.data !== null;

  return (
    <li
      className={props.onOpenCaptain ? "rounded-lg border border-border p-4" : "p-3"}
      data-testid={`crew-proposal-${proposal.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {proposal.kind === "roster"
              ? "Crew proposal · waiting for you"
              : "Add member · waiting for you"}
          </p>
          <h2 className="mt-1 text-base font-semibold leading-snug">{proposal.displayName}</h2>
          {props.onOpenCaptain && props.environmentId !== null ? (
            <div className="mt-1 text-xs text-muted-foreground">
              <CaptainLabel
                environmentId={props.environmentId}
                participantId={proposal.captainParticipantId}
              />
            </div>
          ) : null}
        </div>
        {props.onOpenCaptain ? (
          <Button size="sm" type="button" variant="ghost" onClick={props.onOpenCaptain}>
            Open Captain
          </Button>
        ) : null}
      </div>
      <div className="mt-2 max-w-[72ch] text-sm">
        <p
          className={
            fullBrief
              ? "whitespace-pre-wrap break-words"
              : "line-clamp-2 whitespace-pre-wrap break-words"
          }
        >
          {proposal.brief}
        </p>
        <Button
          type="button"
          size="xs"
          variant="link"
          aria-expanded={fullBrief}
          onClick={() => setFullBrief((full) => !full)}
        >
          {fullBrief ? "Show less" : "Show full brief"}
        </Button>
      </div>
      {playbook === null ? null : (
        <div className="mt-2 text-xs text-muted-foreground">
          <p>
            Follows playbook: <span className="text-foreground">{playbook.title}</span>
          </p>
          {playbook.issue === null ? null : (
            <p className="text-destructive" role="alert">
              {playbook.issue}
            </p>
          )}
        </div>
      )}
      <ul className="mt-2 divide-y divide-border/70">
        {rows.map((row, index) => {
          const seat = seats[index]!;
          const runtime = preview.runtimeSeats?.find((candidate) => candidate.seat === seat.seat);
          return (
            <CrewProposalMemberRow
              key={row.id}
              row={row}
              environmentId={props.environmentId}
              runtime={runtime}
              disabled={props.busy || !canResolve}
              canRemove={rows.length > 1}
              runtimeLoading={preview.loading}
              error={errors.get(row.id)}
              onOpen={(trigger) => {
                editorTrigger.current = trigger;
                setEditing(row);
              }}
              onRemove={() => {
                addButton.current?.focus();
                setRows((current) => current.filter((candidate) => candidate.id !== row.id));
              }}
            >
              {seat.steps?.length ? (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  Steps: {titles(seat.steps)}
                </p>
              ) : null}
              {(runtime !== undefined
                ? (runtime.personaSwaps ?? [])
                : seat.agentId === row.original?.agentId
                  ? (seat.personaSwaps ?? [])
                  : []
              ).map((swap) => (
                <p key={swap.stepId} className="mt-1 break-words text-xs text-warning">
                  {stepTitle(playbook, swap.stepId)} {describePersonaSwap(swap, seat.seat)}
                </p>
              ))}
            </CrewProposalMemberRow>
          );
        })}
      </ul>
      {playbook === null ? null : (
        <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {removedSeatSteps(proposal.requestedSeats, seats).map(({ seat, steps }) => (
            <p key={seat} role="status">
              Removing {seat} leaves {titles(steps)} unowned.
            </p>
          ))}
          {unowned.length ? (
            <p className="break-words">Unowned steps, done by the Captain: {titles(unowned)}</p>
          ) : null}
        </div>
      )}
      {preview.error ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive" role="alert">
            {preview.error}
          </p>
          <Button
            disabled={props.busy || props.environmentId === null || errors.size > 0}
            size="sm"
            type="button"
            variant="outline"
            onClick={preview.refresh}
          >
            Refresh runtime
          </Button>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          ref={addButton}
          aria-label="Add crew member"
          disabled={props.busy || !canResolve}
          size="sm"
          type="button"
          variant="ghost"
          onClick={(event) => {
            editorTrigger.current = event.currentTarget;
            const row = newCrewProposalRow(`added:${nextRow.current++}`);
            setEditing(row);
          }}
        >
          <PlusIcon className="size-4" />
          Add member
        </Button>
        <div className="flex items-center gap-2">
          <Button
            disabled={props.busy || !canResolve}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => props.onResolve("decline", seats)}
          >
            Decline
          </Button>
          <Button
            disabled={!canApprove}
            size="sm"
            type="button"
            onClick={() => {
              if (!canApprove || preview.data === null) return;
              const approvalToken = preview.data.approvalToken;
              preview.refresh();
              props.onResolve("approve", seats, approvalToken);
            }}
          >
            {props.busy
              ? "Working…"
              : `Approve ${rows.length} ${rows.length === 1 ? "member" : "members"}`}
          </Button>
        </div>
      </div>
      {editing && canResolve ? (
        <CrewProposalMemberDialog
          key={editing.id}
          row={editing}
          returnFocus={editorTrigger}
          rows={rows}
          proposalId={proposal.id}
          previewSeatName={editing.original?.seat ?? proposal.requestedSeats[0]!.seat}
          environmentId={props.environmentId}
          workspaceOptions={preview.workspaceOptions}
          agents={agents}
          disabled={props.busy}
          onClose={() => setEditing(null)}
          onSave={(value) => {
            setRows((current) =>
              editing.original === null
                ? [...current, { ...editing, value }]
                : current.map((row) => (row.id === editing.id ? { ...row, value } : row)),
            );
            setEditing(null);
          }}
        />
      ) : null}
    </li>
  );
}
