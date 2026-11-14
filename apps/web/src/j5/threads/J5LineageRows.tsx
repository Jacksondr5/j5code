import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FleetProject } from "@t3tools/contracts/j5";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, CornerLeftUpIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { ThreadDetailsControl } from "../../components/chat/ThreadDetailsControl";
import { ThreadRelationshipIcon } from "../../components/chat/ThreadRelationshipIcon";
import {
  LineageTooltipContent,
  ThreadLineageRowList,
} from "../../components/chat/ThreadRelationshipsControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  useAnyEnvironmentHiding,
  useEnvironmentThreadRefs,
  useHiddenThreadKeys,
  useQuietThreadShell,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentRowIdentity } from "../agents/AgentIdentityChip";
import { fleetSourcesAtom } from "../state";
import { deriveJ5LineageRows, visibleJ5LineageRows, type J5LineageRow } from "./j5Lineage.logic";

const EMPTY: ReadonlyArray<FleetProject> = [];

const ROLE_NAME: Record<J5LineageRow["role"], string> = {
  captain: "Captain",
  parent: "Parent agent",
  seat: "Crew seat",
  peer: "Peer Agent",
};

// The row is narrow beside a persona chip, so it names the role; the tooltip names the Crew.
const rowLabel = (row: J5LineageRow) => row.crew?.seat ?? ROLE_NAME[row.role];

const rowHint = (row: J5LineageRow) => {
  if (row.crew === null) return row.role === "peer" ? "Open Peer Agent" : "Open parent agent";
  return row.crew.seat === null
    ? `Open the Captain of ${row.crew.crewName}`
    : `Open the ${row.crew.seat} seat of ${row.crew.crewName}`;
};

// Keyed per environment so another environment's roster change leaves this panel alone.
const environmentFleetProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(fleetSourcesAtom).sources.find((source) => source.environmentId === environmentId)?.data
        ?.projects ?? EMPTY,
  ),
);

/** The thread's J5 command relations, minus threads the person has hidden. */
export function useJ5LineageRows(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<J5LineageRow> {
  const projects = useAtomValue(environmentFleetProjectsAtom(environmentId));
  const hiddenKeys = useHiddenThreadKeys();
  const hidingAnywhere = useAnyEnvironmentHiding();
  // Read only while hiding: the loaded set matters for nothing else.
  const loadedRefs = useEnvironmentThreadRefs(hidingAnywhere ? environmentId : null);
  return visibleJ5LineageRows(deriveJ5LineageRows(projects, threadId), {
    isHidden: (rowThreadId) => hiddenKeys.has(threadKey({ environmentId, threadId: rowThreadId })),
    hidingAnywhere,
    loaded: new Set(loadedRefs.map((ref) => ref.threadId)),
  });
}

function J5LineageRowItem(props: {
  readonly environmentId: EnvironmentId;
  readonly row: J5LineageRow;
}) {
  const navigate = useNavigate();
  const ref = scopeThreadRef(props.environmentId, props.row.threadId);
  const shell = useQuietThreadShell(ref);
  const label = rowLabel(props.row);
  const title = shell?.title ?? props.row.displayName ?? label;
  const isChild = props.row.role === "seat" || props.row.role === "peer";
  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <div className="flex min-w-0 flex-1 items-center">
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(ref),
                  })
                }
              />
            }
          >
            <ThreadRelationshipIcon
              fallbackIcon={isChild ? BotIcon : CornerLeftUpIcon}
              status={shell?.runtime?.status ?? null}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                {title}
              </span>
            </span>
            <span className="max-w-[45%] shrink-0 truncate text-2xs text-muted-foreground">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left">
            <LineageTooltipContent title={title} hint={rowHint(props.row)} />
          </TooltipPopup>
        </Tooltip>
      </div>
      {isChild ? (
        <AgentRowIdentity environmentId={props.environmentId} childThreadId={props.row.threadId} />
      ) : null}
    </li>
  );
}

/** J5's rows in upstream's Lineage section: who commands this thread and who it commands. */
export function J5LineageRows(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<J5LineageRow>;
}) {
  if (props.rows.length === 0) return null;
  return (
    <ThreadLineageRowList hiddenCount={0} onShowMore={() => {}}>
      {props.rows.map((row) => (
        <J5LineageRowItem
          key={`${row.role}:${row.threadId}`}
          environmentId={props.environmentId}
          row={row}
        />
      ))}
    </ThreadLineageRowList>
  );
}
