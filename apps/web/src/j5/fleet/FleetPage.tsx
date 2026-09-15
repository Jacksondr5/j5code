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
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { fleetSourcesAtom } from "../state";
import { formatCrewStateSummary, summarizeCrewState } from "../crew/crewState";
import { buildFleetTree, originLabel, type FleetNode, type FleetRow } from "./fleet.logic";
import { mergeFleetSources, refreshFleet, useFleetRefresh } from "./fleetClient";

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
  const sources = useAtomValue(fleetSourcesAtom);
  useFleetRefresh();
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
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
  return (
    <>
      <FleetRowItem
        row={node.row}
        badge={seatBadge ?? (node.crews.length > 0 ? "Captain" : null)}
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

function FleetRowItem(
  props: FleetRowsProps & { readonly row: FleetRow; readonly badge: string | null },
) {
  const { agent } = props.row;
  const thread =
    agent.threadId === null
      ? undefined
      : props.threadsByKey.get(
          scopedThreadKey(scopeThreadRef(props.environmentId, ThreadId.make(agent.threadId))),
        );
  const status =
    thread === undefined || agent.archived ? null : resolveThreadStatusPill({ thread });
  const title = thread?.title ?? agent.displayName ?? agent.participantId;
  // A retired placeholder (fleet-page AC11) has no facts to measure: its cells read "n/a", not "?".
  const lastActivity = agent.archived
    ? "n/a"
    : thread === undefined
      ? "?"
      : formatElapsedDurationLabel(thread.updatedAt) || "just now";
  return (
    <li>
      <button
        type="button"
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_8rem_5rem_7rem] items-center gap-3 px-3 py-2 text-left text-sm outline-hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
          agent.archived && "opacity-60",
        )}
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
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {props.badge}
            </Badge>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          {status === null ? (
            <span className="text-muted-foreground">
              {agent.archived ? "Retired" : thread === undefined ? "?" : "Idle"}
            </span>
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
