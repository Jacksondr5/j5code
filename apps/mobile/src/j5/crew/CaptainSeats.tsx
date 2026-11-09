import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { seatQuietLabel } from "@t3tools/client-runtime/j5/crew-state";
import {
  groupSpawnedChildren,
  selectSpawnedChildRows,
  spawnedChildrenCountLabel,
  stoppableCrew,
  type SpawnedChildGroup,
} from "@t3tools/client-runtime/j5/spawned-children";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SpawnedChild } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { useState, useSyncExternalStore } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import {
  resolveThreadListV2Status,
  type ThreadListV2Status,
} from "../../features/threads/threadListV2";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShells } from "../../state/entities";
import { j5Environment } from "../state";
import { useSpawnedChildren } from "./spawnedChildren";

/** Upstream's row status labels, handed in by the row so seats read the way rows do. */
export type SeatStatusLabels = Partial<
  Record<
    ThreadListV2Status,
    {
      readonly label: string;
      readonly icon: AppSymbolName;
      readonly className: string;
      readonly iconTintClassName: string;
    }
  >
>;

// Expanded spawners for this session, shared by the in-row toggle and the seats below the row.
let expanded: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const expansionKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}/${thread.id}`;
/** One row's expansion, so toggling a row re-renders only that row. */
const useIsExpanded = (key: string) => {
  const read = () => expanded.has(key);
  return useSyncExternalStore(subscribe, read, read);
};
const toggle = (key: string) => {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded = next;
  listeners.forEach((listener) => listener());
};

function useGroups(thread: EnvironmentThreadShell, children: ReadonlyArray<SpawnedChild>) {
  const threads = useThreadShells();
  // Children are placed on the parent's environment; the same local id elsewhere is unrelated.
  const threadsById = new Map(
    threads
      .filter((candidate) => candidate.environmentId === thread.environmentId)
      .map((candidate) => [candidate.id as string, candidate]),
  );
  return groupSpawnedChildren(selectSpawnedChildRows(children, threadsById));
}

/**
 * The spawner's count and expand control, inside its existing row so a collapsed row is no
 * taller. Most rows have no children and render nothing.
 */
export function CaptainSeatsToggle(props: {
  readonly thread: EnvironmentThreadShell;
  readonly mutedClassName: string;
}) {
  const children = useSpawnedChildren(scopeThreadRef(props.thread.environmentId, props.thread.id));
  if (children.length === 0) return null;
  return <SeatsToggle {...props} spawned={children} />;
}

function SeatsToggle(props: {
  readonly thread: EnvironmentThreadShell;
  readonly mutedClassName: string;
  readonly spawned: ReadonlyArray<SpawnedChild>;
}) {
  const groups = useGroups(props.thread, props.spawned);
  const key = expansionKey(props.thread);
  const isOpen = useIsExpanded(key);
  if (groups.length === 0) return null;
  const count = spawnedChildrenCountLabel(groups);
  const needsAttention = !isOpen && groups.some((group) => group.needsAttention);
  return (
    // As tall as the provider icon beside it, so the text's taller line box can't grow the row.
    <View className="h-3.5 justify-center">
      <Pressable
        // Padding cancelled by negative margin grows the touch target, as the PR badge does.
        className="-m-2.5 flex-row items-center p-2.5"
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        accessibilityLabel={`${count}${needsAttention ? ", an agent needs you" : ""}`}
        onPress={() => toggle(key)}
        onLongPress={() => undefined}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name={isOpen ? "chevron.down" : "chevron.right"}
          size={10}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
          weight="semibold"
        />
        <Text className={cn("ml-1 text-xs", props.mutedClassName)} numberOfLines={1}>
          {count}
        </Text>
        {needsAttention ? <View className="ml-1 size-1.5 rounded-full bg-warning" /> : null}
      </Pressable>
    </View>
  );
}

/** The seats and agents under an expanded spawner's row, one block per Crew and one for solo agents. */
export function CaptainSeats(props: {
  readonly thread: EnvironmentThreadShell;
  readonly statusLabels: SeatStatusLabels;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const children = useSpawnedChildren(scopeThreadRef(props.thread.environmentId, props.thread.id));
  const isOpen = useIsExpanded(expansionKey(props.thread));
  if (!isOpen || children.length === 0) return null;
  return <SeatGroups {...props} spawned={children} />;
}

function SeatGroups(props: {
  readonly thread: EnvironmentThreadShell;
  readonly statusLabels: SeatStatusLabels;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly spawned: ReadonlyArray<SpawnedChild>;
}) {
  const groups = useGroups(props.thread, props.spawned);
  return (
    <View className="pb-2 pl-8 pr-5">
      {groups.map((group) => (
        <SeatGroup
          key={group.key}
          environmentId={props.thread.environmentId}
          group={group}
          statusLabels={props.statusLabels}
          onSelectThread={props.onSelectThread}
        />
      ))}
    </View>
  );
}

function SeatGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly group: SpawnedChildGroup<EnvironmentThreadShell>;
  readonly statusLabels: SeatStatusLabels;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { group } = props;
  const canStop = useAtomValue(j5Environment.stopCrew.permissionAtom(props.environmentId));
  const stoppable = canStop ? stoppableCrew(group) : null;
  const [stopping, setStopping] = useState(false);
  const stop = (crew: { readonly crewInstanceId: string; readonly crewName: string }) => {
    setStopping(true);
    void j5Environment.stopCrew
      .run(appAtomRegistry, {
        environmentId: props.environmentId,
        input: { crewInstanceId: crew.crewInstanceId },
      })
      .then((result) => {
        if (result._tag === "Failure") throw Cause.squash(result.cause);
      })
      .catch((error: unknown) => {
        Alert.alert(
          `Couldn't stop crew ${crew.crewName}`,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setStopping(false));
  };
  return (
    <View className="mt-1">
      <View className="min-h-8 flex-row items-center">
        <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
          {group.crew === null ? null : (
            <Text className="text-xs font-t3-medium text-foreground">{group.crew.crewName} · </Text>
          )}
          {group.summary}
        </Text>
        {stoppable === null ? null : (
          // Interrupts this Crew's running seats; it retires nothing.
          <Pressable
            className="ml-auto rounded-md border border-border px-2 py-1"
            accessibilityRole="button"
            accessibilityLabel={`Stop crew ${stoppable.crewName}`}
            disabled={stopping}
            onPress={() => stop(stoppable)}
            style={({ pressed }) => ({ opacity: stopping ? 0.5 : pressed ? 0.6 : 1 })}
          >
            <Text className="text-xs font-t3-medium text-foreground">Stop crew</Text>
          </Pressable>
        )}
      </View>
      {group.rows.map(({ child, thread }) => (
        <SeatRow
          key={child.threadId}
          child={child}
          thread={thread}
          statusLabels={props.statusLabels}
          onSelectThread={props.onSelectThread}
        />
      ))}
    </View>
  );
}

function SeatStatus(props: {
  readonly child: SpawnedChild;
  readonly thread: EnvironmentThreadShell;
  readonly statusLabels: SeatStatusLabels;
}) {
  const { child, thread } = props;
  // A replaced member's last run says nothing about it now; being replaced does.
  if (child.replaced !== undefined)
    return (
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        Replaced by {child.replaced.replacedBy}
      </Text>
    );
  const status = resolveThreadListV2Status(thread);
  // Upstream reads an idle session as Waiting; a seat says how its last run ended instead.
  const live =
    status === "waiting" && thread.runtime?.status === "idle"
      ? undefined
      : props.statusLabels[status];
  if (live === undefined)
    return (
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {child.seat === null
          ? "Idle"
          : seatQuietLabel({ notStarted: child.seat.notStarted, runtime: thread.runtime })}
      </Text>
    );
  return (
    <View className="flex-row items-center">
      <SymbolView
        name={live.icon}
        size={12}
        tintColorClassName={live.iconTintClassName}
        type="monochrome"
        weight="semibold"
      />
      <Text className={cn("ml-1 text-xs font-t3-bold", live.className)}>{live.label}</Text>
    </View>
  );
}

function SeatRow(props: {
  readonly child: SpawnedChild;
  readonly thread: EnvironmentThreadShell | undefined;
  readonly statusLabels: SeatStatusLabels;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { child, thread } = props;
  // A seat the client holds no facts for is listed, not opened: there may be no thread.
  if (thread === undefined)
    return (
      <View className="border-l border-border py-1.5 pl-3">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {child.seat?.seat ?? "Seat"}
        </Text>
        <Text className="text-xs text-foreground-muted">Unknown</Text>
      </View>
    );
  // A seat thread is titled by its seat, so the badge repeats it only once renamed.
  const renamedSeat =
    child.seat !== null && child.seat.seat !== thread.title ? child.seat.seat : null;
  return (
    <Pressable
      className="border-l border-border py-1.5 pl-3"
      accessibilityRole="button"
      onPress={() => props.onSelectThread(thread)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="flex-row items-center">
        {renamedSeat === null ? null : (
          <View className="mr-1.5 rounded-full border border-border px-1.5">
            <Text className="text-xs text-foreground-muted">{renamedSeat}</Text>
          </View>
        )}
        <Text className="min-w-0 shrink text-sm text-foreground" numberOfLines={1}>
          {thread.title}
        </Text>
        <Text className="ml-auto pl-2 text-xs tabular-nums text-foreground-tertiary">
          {relativeTime(thread.updatedAt)}
        </Text>
      </View>
      <SeatStatus child={child} thread={thread} statusLabels={props.statusLabels} />
    </Pressable>
  );
}
