import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { j5SourceNotice } from "@t3tools/client-runtime/j5/inbox";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { CaptainMark } from "../squadron/CaptainMark";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { fleetDetailSourcesAtom } from "../state";
import { requestConfirmDialog } from "../../confirmDialog";
import { ArchiveWarningCrewSeats, type ArchiveWarningCrew } from "../a2a/ArchiveWarningContent";
import { archiveCrew } from "../crew/crewArchiveClient";
import {
  classifyCrewSeat,
  crewHasRunningSeat,
  formatCrewStateSummary,
  summarizeCrewState,
} from "../crew/crewState";
import { stopCrew } from "../crew/crewStopClient";
import {
  buildFleetTree,
  originLabel,
  retiredCrews,
  type FleetNode,
  type FleetRow,
} from "./fleet.logic";
import {
  mergeFleetSources,
  refreshFleet,
  useFleetDetailRefresh,
  type FleetCrew,
  type ScopedFleetSquadron,
} from "./fleetClient";

/**
 * The Roster (SB6): every agent in every Squadron on every connected environment, indented by
 * placement, with Crews as collapsible units under their Captain. Status and last activity come
 * from the client's thread state; placement, provenance, seats, and owed asks come from each
 * environment's ledger read. Unknowns render as "?" because a visibly missing fact beats a
 * plausible fake.
 */
export function FleetPage() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const sources = useAtomValue(fleetDetailSourcesAtom);
  useFleetDetailRefresh();
  const [refreshing, setRefreshing] = useState(false);
  const squadrons = useMemo(() => mergeFleetSources(sources), [sources]);
  const showEnvironment = spansMultipleEnvironments(squadrons);
  const loading = !sources.isReady || sources.sources.some((source) => source.status === "loading");
  const notices = [
    ...new Set(
      sources.sources.flatMap((source) => {
        const notice = j5SourceNotice(source);
        return notice === null ? [] : [notice];
      }),
    ),
  ];

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshFleet();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const threadsByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [threads],
  );
  const openThread = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
      });
    },
    [navigate],
  );

  const agentCount = squadrons.reduce((count, squadron) => count + squadron.agents.length, 0);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
            !isElectron && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            isElectron && "drag-region h-[52px]",
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Fleet breadcrumb">
            <WorkspaceBreadcrumbItem current>Fleet</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
              <div>
                <h1 className="text-balance text-2xl font-semibold tracking-tight">Fleet</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loading && squadrons.length === 0
                    ? "Reading the roster…"
                    : `${agentCount} ${agentCount === 1 ? "agent" : "agents"} across ${squadrons.length} ${squadrons.length === 1 ? "Squadron" : "Squadrons"}`}
                </p>
              </div>
              <Button
                aria-label="Refresh fleet"
                disabled={refreshing}
                onClick={() => void refresh()}
                size="sm"
                variant="outline"
              >
                <RefreshCwIcon aria-hidden className={cn("size-4", refreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>
            {notices.length > 0 ? (
              <ul className="mt-4 space-y-1 text-sm text-muted-foreground" aria-live="polite">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            ) : null}
            {!loading && squadrons.length === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">
                No Squadrons yet. Agents appear here once a Squadron has members.
              </p>
            ) : null}
            {squadrons.map((squadron) => (
              <section
                key={`${squadron.environmentId}:${squadron.id}`}
                className="mt-8"
                aria-label={`Squadron ${squadron.name}`}
              >
                <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{squadron.name}</span>
                  {showEnvironment ? (
                    <span className="text-xs font-normal normal-case tracking-normal text-muted-foreground/70">
                      {squadron.environmentLabel}
                    </span>
                  ) : null}
                </h2>
                {squadron.agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No agents.</p>
                ) : (
                  <FleetTable
                    environmentId={squadron.environmentId}
                    nodes={buildFleetTree(squadron)}
                    threadsByKey={threadsByKey}
                    onOpenThread={openThread}
                  />
                )}
                <RetiredCrews
                  squadron={squadron}
                  threadsByKey={threadsByKey}
                  onOpenThread={openThread}
                />
              </section>
            ))}
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

interface FleetRowsProps {
  readonly environmentId: EnvironmentId;
  readonly threadsByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: string) => void;
}

function FleetTable(props: FleetRowsProps & { readonly nodes: ReadonlyArray<FleetNode> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_7rem] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <span>Agent</span>
        <span>Status</span>
        <span className="text-right">Open asks</span>
        <span className="text-right">Last activity</span>
      </div>
      <ul className="divide-y divide-border/60">
        {props.nodes.map((node) => (
          <FleetNodeRows
            key={node.row.agent.participantId}
            node={node}
            environmentId={props.environmentId}
            threadsByKey={props.threadsByKey}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </ul>
    </div>
  );
}

function FleetNodeRows(
  props: FleetRowsProps & { readonly node: FleetNode; readonly seatBadge?: string | null },
) {
  const { node, seatBadge, ...rows } = props;
  // "What is the state of this Crew?" from the seats' measured facts, no Playbook required.
  const crewState = (members: ReadonlyArray<FleetRow>) =>
    summarizeCrewState(
      members.map(({ agent }) =>
        agent.threadId === null
          ? undefined
          : props.threadsByKey.get(
              scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(agent.threadId))),
            ),
      ),
    );
  // The person's Stop crew: interrupts every running seat, retires nothing. The seats' status
  // pills tell the truth afterwards; a refused or failed call says so, since a button that does
  // nothing visible is a lying spinner.
  const [busy, setBusy] = useState<string | null>(null);
  const stop = async (crew: { crewInstanceId: string; crewName: string }) => {
    setBusy(crew.crewInstanceId);
    try {
      await stopCrew(props.environmentId, crew.crewInstanceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not stop crew ${crew.crewName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  // The person's Archive crew: the same unit archive the Captain has, behind one dialog that
  // lists every seat with what ends for it. The Crew moves to the Squadron's retired list.
  const archive = async (
    crew: { crewInstanceId: string; crewName: string },
    seats: ReadonlyArray<FleetRow>,
  ) => {
    const warning: ArchiveWarningCrew = {
      crewInstanceId: crew.crewInstanceId,
      crewName: crew.crewName,
      seats: seats.map(({ agent }) => {
        const thread =
          agent.threadId === null
            ? undefined
            : props.threadsByKey.get(
                scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(agent.threadId))),
              );
        const displayName = thread?.title ?? agent.displayName;
        return {
          seat: agent.crew?.seat ?? agent.participantId,
          participant:
            displayName === null
              ? { displayName: "Unnamed participant", tooltipParticipantId: agent.participantId }
              : { displayName, tooltipParticipantId: null },
          runningTurn: classifyCrewSeat(thread) === "running",
          openAsks: agent.openAsks,
        };
      }),
    };
    const consequential = warning.seats.some((seat) => seat.runningTurn || seat.openAsks > 0);
    const confirmed = await (requestConfirmDialog(
      `Archive crew ${crew.crewName}?`,
      { variant: "destructive" },
      {
        content: (
          <div className="space-y-3 text-left">
            <p>Its {warning.seats.length === 1 ? "seat retires" : "seats retire"} together:</p>
            <ArchiveWarningCrewSeats crew={warning} />
            <p className="border-t border-border/60 pt-3 text-muted-foreground">
              Worktrees, branches, and pull requests remain. The roster stays readable under Retired
              crews.
            </p>
          </div>
        ),
        confirmLabel: consequential ? "Archive anyway" : "Archive",
      },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(crew.crewInstanceId);
    try {
      await archiveCrew(props.environmentId, crew.crewInstanceId);
      refreshFleet();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not archive crew ${crew.crewName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <FleetRowItem
        row={node.row}
        badge={seatBadge ?? null}
        captainOf={node.crews.map((crew) => crew.crewName)}
        {...rows}
      />
      {node.crews.map((crew) => (
        <li key={crew.crewInstanceId} className="bg-muted/20">
          <details open className="group/crew">
            <summary
              className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
              style={{ paddingInlineStart: `${0.75 + (node.row.depth + 1) * 1.25}rem` }}
            >
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform duration-150 group-open/crew:rotate-90"
              />
              <span>Crew · {crew.crewName}</span>
              {(() => {
                const seats = crew.members.map((member) => member.row);
                const state = crewState(seats);
                const summary = formatCrewStateSummary(state);
                return (
                  <>
                    <span className="text-muted-foreground/70">
                      {crew.members.length} {crew.members.length === 1 ? "seat" : "seats"}
                      {summary === null ? "" : ` · ${summary}`}
                    </span>
                    <span className="ms-auto flex items-center gap-1.5">
                      {crewHasRunningSeat(state) ? (
                        <Button
                          aria-label={`Stop crew ${crew.crewName}`}
                          disabled={busy === crew.crewInstanceId}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void stop(crew);
                          }}
                          size="xs"
                          variant="outline"
                        >
                          Stop crew
                        </Button>
                      ) : null}
                      <Button
                        aria-label={`Archive crew ${crew.crewName}`}
                        disabled={busy === crew.crewInstanceId}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void archive(crew, seats);
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        Archive crew
                      </Button>
                    </span>
                  </>
                );
              })()}
            </summary>
            <ul className="divide-y divide-border/40 border-t border-border/40">
              {crew.members.map((member) => (
                <FleetNodeRows
                  key={member.row.agent.participantId}
                  node={member}
                  seatBadge={member.row.agent.crew?.seat ?? null}
                  {...rows}
                />
              ))}
            </ul>
          </details>
        </li>
      ))}
      {node.children.map((child) => (
        <FleetNodeRows key={child.row.agent.participantId} node={child} {...rows} />
      ))}
    </>
  );
}

/**
 * Retired Crews of one Squadron as one-line rows that open to the brief and the approved roster
 * with each seat's approval version and reason, so a successor can be proposed from what was
 * decided rather than from memory (Crews AC20). A retired Crew can never be reactivated, so its
 * row offers no action beyond naming its Captain, whose thread holds the ledger; handoffs live on
 * the Artifacts page.
 */
function RetiredCrews(
  props: Omit<FleetRowsProps, "environmentId"> & { readonly squadron: ScopedFleetSquadron },
) {
  const crews = retiredCrews(props.squadron);
  if (crews.length === 0) return null;
  return (
    <details className="group/retired mt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-open/retired:rotate-90"
        />
        Retired crews ({crews.length})
      </summary>
      <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
        {crews.map((crew) => (
          <RetiredCrewItem
            key={crew.crewInstanceId}
            crew={crew}
            environmentId={props.squadron.environmentId}
            threadsByKey={props.threadsByKey}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </ul>
    </details>
  );
}

function RetiredCrewItem(props: FleetRowsProps & { readonly crew: FleetCrew }) {
  const { crew } = props;
  const seatCount = crew.roster.length;
  return (
    <li>
      <details className="group/retired-crew">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm outline-hidden marker:hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open/retired-crew:rotate-90"
          />
          <span className="min-w-0 truncate font-medium text-foreground/80">{crew.crewName}</span>
          <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            v{crew.version} · {seatCount} {seatCount === 1 ? "seat" : "seats"} · retired{" "}
            {crew.archivedAt === null ? (
              "?"
            ) : (
              <time dateTime={crew.archivedAt}>
                {formatElapsedDurationLabel(crew.archivedAt) || "just now"}
              </time>
            )}
          </span>
        </summary>
        <div className="border-t border-border/40 px-3 py-2 ps-[2.125rem] text-xs">
          <RetiredCrewCaptain {...props} />
          <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{crew.brief}</p>
          {crew.roster.length === 0 ? (
            <p className="mt-2 text-muted-foreground">No seats were approved.</p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {crew.roster.map((member) => (
                <li key={member.seat} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="uppercase tracking-wide text-muted-foreground">
                    {member.seat}
                  </span>
                  <span className="text-foreground/80">{member.agentId ?? "Custom seat"}</span>
                  <span className="text-muted-foreground">
                    approved at v{member.addedVersion}
                    {member.reason === null ? "" : ` · ${member.reason}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * The Captain's thread keeps the retired Crew's ledger. Archived threads are not in the active
 * thread shells (nor are deleted ones), and the thread route redirects home for them, so only a
 * live Captain is linked. Until the shells load, a missing thread says nothing about archive.
 */
function RetiredCrewCaptain(props: FleetRowsProps & { readonly crew: FleetCrew }) {
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { captainThreadId } = props.crew;
  if (captainThreadId === null) return null;
  const thread = props.threadsByKey.get(
    scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(captainThreadId))),
  );
  return (
    <p className="text-muted-foreground">
      Captain:{" "}
      {thread === undefined ? (
        shellsBootstrapped ? (
          "no longer active. If it was archived, unarchive it from Settings → Archived to read its ledger."
        ) : (
          "unavailable."
        )
      ) : (
        <button
          type="button"
          className="text-foreground/80 underline underline-offset-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onOpenThread(props.environmentId, captainThreadId)}
        >
          {thread.title}
        </button>
      )}
    </p>
  );
}

function FleetRowItem(
  props: FleetRowsProps & {
    readonly row: FleetRow;
    readonly badge: string | null;
    /** Names of the live Crews this row commands; non-empty rows carry the Captain mark. */
    readonly captainOf?: ReadonlyArray<string>;
  },
) {
  const { agent } = props.row;
  const thread =
    agent.threadId === null
      ? undefined
      : props.threadsByKey.get(
          scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(agent.threadId))),
        );
  const status = thread === undefined ? null : resolveThreadStatusPill({ thread });
  const title = thread?.title ?? agent.displayName ?? agent.participantId;
  const lastActivity =
    thread === undefined ? "?" : formatElapsedDurationLabel(thread.updatedAt) || "just now";
  return (
    <li>
      <button
        type="button"
        className="grid w-full grid-cols-[minmax(0,1fr)_8rem_5rem_7rem] items-center gap-3 px-3 py-2 text-left text-sm outline-hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        style={{ paddingInlineStart: `${0.75 + props.row.depth * 1.25}rem` }}
        disabled={agent.threadId === null}
        onClick={() => {
          if (agent.threadId !== null) props.onOpenThread(props.environmentId, agent.threadId);
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {agent.origin === "human" ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {originLabel(agent.origin)}
            </span>
          )}
          {props.badge ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              {props.badge}
            </Badge>
          ) : null}
          {props.captainOf !== undefined && props.captainOf.length > 0 ? (
            <CaptainMark title={`Commands ${props.captainOf.join(", ")}`} />
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          {status === null ? (
            <span className="text-muted-foreground">{thread === undefined ? "?" : "Idle"}</span>
          ) : (
            <>
              <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
              <span className={status.colorClass}>{status.label}</span>
            </>
          )}
        </span>
        <span
          className={cn(
            "text-right text-xs tabular-nums",
            agent.openAsks > 0 ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {agent.openAsks}
        </span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {lastActivity}
        </span>
      </button>
    </li>
  );
}
