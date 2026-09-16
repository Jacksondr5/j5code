import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useSpawnedChildren, type SpawnedChild } from "./SpawnedChildrenClient";
import {
  groupSpawnedChildren,
  readExpandedSpawnParents,
  selectSpawnedChildRows,
  spawnedGroupExpansionKey,
  writeExpandedSpawnParents,
  type SpawnedChildGroup,
} from "./spawnedChildren.logic";

// One process-wide expansion set, mirrored to localStorage, shared by every card.
const expansionListeners = new Set<() => void>();
let expanded: ReadonlySet<string> = readExpandedSpawnParents(
  typeof localStorage === "undefined" ? undefined : localStorage,
);
const subscribeExpansion = (listener: () => void) => {
  expansionListeners.add(listener);
  return () => expansionListeners.delete(listener);
};
const getExpansion = () => expanded;
const toggleExpansion = (expansionKey: string) => {
  const next = new Set(expanded);
  if (next.has(expansionKey)) next.delete(expansionKey);
  else next.add(expansionKey);
  expanded = next;
  writeExpandedSpawnParents(typeof localStorage === "undefined" ? undefined : localStorage, next);
  expansionListeners.forEach((listener) => listener());
};

/**
 * SB5 refinement: agent-spawned Peer Agents stay out of the flat list, but the row that spawned
 * them (a Captain or any spawner) can expand into its placed children so the work is one click
 * away. Each Crew the row commands is its own named, collapsible group, and the solo peers it
 * spawned form one more; collapsed by default, with a measured "needs a human" fact on any child
 * shown on the collapsed header.
 */
export function SpawnedChildren(props: { readonly thread: EnvironmentThreadShell }) {
  // Every sidebar row mounts this; most rows have no children. Only the cheap children snapshot
  // is read here, so a row without children never subscribes to the shell list and the
  // SidebarThreadRow memo keeps its value on every shell change.
  const children = useSpawnedChildren(scopeThreadRef(props.thread.environmentId, props.thread.id));
  if (children.length === 0) return null;
  return <SpawnedChildrenRows thread={props.thread} spawned={children} />;
}

function SpawnedChildrenRows(props: {
  readonly thread: EnvironmentThreadShell;
  readonly spawned: ReadonlyArray<SpawnedChild>;
}) {
  const children = props.spawned;
  const threads = useThreadShells();
  const expandedSet = useSyncExternalStore(subscribeExpansion, getExpansion, getExpansion);
  const navigate = useNavigate();
  // Children are placed on the parent's environment; the same local id elsewhere is unrelated.
  const threadsById = useMemo(
    () =>
      new Map(
        threads
          .filter((thread) => thread.environmentId === props.thread.environmentId)
          .map((thread) => [thread.id as string, thread]),
      ),
    [props.thread.environmentId, threads],
  );
  const rows = useMemo(
    () => selectSpawnedChildRows(children, threadsById),
    [children, threadsById],
  );
  const open = useCallback(
    (child: EnvironmentThreadShell) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(child.environmentId, child.id)),
      });
    },
    [navigate],
  );
  const groups = useMemo(() => groupSpawnedChildren(rows), [rows]);
  if (groups.length === 0) return null;
  return (
    <div
      className="ms-6 me-2 mb-1 flex flex-col gap-0.5"
      data-testid={`spawned-children-${props.thread.id}`}
    >
      {groups.map((group) => (
        <SpawnedChildGroupRows
          key={group.key}
          group={group}
          isOpen={expandedSet.has(spawnedGroupExpansionKey(props.thread.id, group.key))}
          onToggle={() => toggleExpansion(spawnedGroupExpansionKey(props.thread.id, group.key))}
          onOpen={open}
        />
      ))}
    </div>
  );
}

function SpawnedChildGroupRows(props: {
  readonly group: SpawnedChildGroup<EnvironmentThreadShell>;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly onOpen: (child: EnvironmentThreadShell) => void;
}) {
  const { group, isOpen } = props;
  return (
    <div data-testid={`spawned-group-${group.key}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform duration-150", isOpen && "rotate-90")}
          />
          {group.crew !== null ? (
            <span className="truncate text-foreground">{group.crew.crewName}</span>
          ) : null}
          <span className="truncate">{group.summary}</span>
          {group.needsAttention && !isOpen ? (
            <span
              aria-label="An agent needs a human"
              className="ms-auto size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90"
            />
          ) : null}
        </button>
      </div>
      {isOpen ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 border-s border-border/60 ps-2">
          {group.rows.map(({ child, thread }) => {
            const status = resolveThreadStatusPill({ thread });
            const elapsed = formatElapsedDurationLabel(thread.updatedAt);
            return (
              <li key={child.threadId}>
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpen(thread);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    {child.seat ? (
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                        {child.seat.seat}
                      </Badge>
                    ) : null}
                    <span className="truncate text-foreground">{thread.title}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {status === null ? (
                      <span>Idle</span>
                    ) : (
                      <>
                        <span
                          aria-hidden
                          className={cn("size-1.5 rounded-full", status.dotClass)}
                        />
                        <span className={status.colorClass}>{status.label}</span>
                      </>
                    )}
                    {elapsed ? <span className="ms-auto tabular-nums">{elapsed}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
