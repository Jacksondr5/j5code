import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewAgentStatus } from "@t3tools/client-runtime/j5/crew-state";
import {
  groupSpawnedChildren,
  j5AgentsPillSegment,
  selectSpawnedChildRows,
  stoppableCrew,
  type SpawnedChildGroup,
} from "@t3tools/client-runtime/j5/spawned-children";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  SubagentPillSegment,
  ThreadTurnSubagents,
} from "@t3tools/client-runtime/state/thread-subagents";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { SpawnedChild } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import {
  SUBAGENT_TONE_TEXT_CLASS,
  SubagentStatusDot,
} from "../../features/threads/SubagentStatusDot";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShells } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { j5Environment } from "../state";
import { useThreadSpawnedChildren } from "./spawnedChildren";

type ChildTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

// "running/total" for one thread's children, so the pill re-renders only when a count changes.
const childCountsAtom = Atom.family((key: string) => {
  const [environmentId, children] = JSON.parse(key) as [EnvironmentId, Array<[ThreadId, boolean]>];
  return Atom.make((get) => {
    let running = 0;
    let total = 0;
    for (const [threadId, isSeat] of children) {
      const shell = get(
        environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
      );
      // The same rows the sheet lists: no archived child, and no solo agent the client lacks.
      if (shell === null ? !isSeat : shell.archivedAt !== null) continue;
      total += 1;
      if (shell !== null && threadRuntimeIsActive(shell.runtime)) running += 1;
    }
    return `${running}/${total}`;
  }).pipe(Atom.withLabel(`mobile-j5:spawned-child-counts:${key}`));
});

/** Upstream's Agents pill segment, counting the Crew seats and Peer Agents the thread spawned. */
export function useJ5AgentsPillSegment(
  ref: ScopedThreadRef | null,
  turn: ThreadTurnSubagents | null,
  upstream: SubagentPillSegment | null,
): SubagentPillSegment | null {
  const children = useThreadSpawnedChildren(ref);
  const counts = useAtomValue(
    childCountsAtom(
      JSON.stringify([
        ref?.environmentId ?? null,
        children.map((child) => [child.threadId, child.seat !== null]),
      ]),
    ),
  );
  const [running = 0, total = 0] = counts.split("/").map(Number);
  return j5AgentsPillSegment(turn, upstream, { running, total });
}

/** Whether the sheet lists spawned agents, so upstream's empty text stays only for an empty sheet. */
export function useHasJ5Agents(ref: ScopedThreadRef): boolean {
  return useThreadSpawnedChildren(ref).length > 0;
}

/**
 * The thread's Crew seats and Peer Agents in upstream's Agents sheet: one block per Crew, with
 * Stop crew while a seat runs, and one for agents spawned outside a Crew.
 */
export function J5ThreadAgents(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: (child: ChildTarget) => void;
}) {
  const children = useThreadSpawnedChildren(scopeThreadRef(props.environmentId, props.threadId));
  if (children.length === 0) return null;
  return <SpawnedAgentGroups {...props} spawned={children} />;
}

function SpawnedAgentGroups(props: {
  readonly environmentId: EnvironmentId;
  readonly onOpen: (child: ChildTarget) => void;
  readonly spawned: ReadonlyArray<SpawnedChild>;
}) {
  const threads = useThreadShells();
  // Children are placed on the parent's environment; the same local id elsewhere is unrelated.
  const threadsById = new Map(
    threads
      .filter((thread) => thread.environmentId === props.environmentId)
      .map((thread) => [thread.id as string, thread]),
  );
  const groups = groupSpawnedChildren(selectSpawnedChildRows(props.spawned, threadsById));
  return (
    <>
      {groups.map((group) => (
        <SpawnedAgentGroup
          key={group.key}
          environmentId={props.environmentId}
          group={group}
          onOpen={props.onOpen}
        />
      ))}
    </>
  );
}

function SpawnedAgentGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly group: SpawnedChildGroup<EnvironmentThreadShell>;
  readonly onOpen: (child: ChildTarget) => void;
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
    <View>
      <View className="min-h-11 flex-row items-center border-b border-border pt-3">
        <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
          <Text className="text-xs font-t3-medium text-foreground">
            {group.crew === null ? "Peer Agents" : group.crew.crewName}
          </Text>
          {group.crew === null ? null : ` · ${group.summary}`}
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
        <SpawnedAgentRow
          key={child.threadId}
          environmentId={props.environmentId}
          child={child}
          thread={thread}
          onOpen={props.onOpen}
        />
      ))}
    </View>
  );
}

function SpawnedAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly child: SpawnedChild;
  readonly thread: EnvironmentThreadShell | undefined;
  readonly onOpen: (child: ChildTarget) => void;
}) {
  const { child, thread } = props;
  const status = crewAgentStatus(
    { isSeat: child.seat !== null, replacedBy: child.replaced?.replacedBy ?? null },
    thread,
  );
  // A seat thread is titled by its seat, so the seat is named again only once renamed.
  const renamedSeat =
    child.seat !== null && thread !== undefined && child.seat.seat !== thread.title
      ? child.seat.seat
      : null;
  const row = (
    <View className="flex-row gap-3 py-3.5">
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={status.tone} placement="sheet" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 shrink font-t3-medium text-sm text-foreground"
            >
              {thread?.title ?? child.seat?.seat ?? "Agent"}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="shrink-0 text-xs text-foreground-muted"
            >
              ·
            </Text>
            <Text
              numberOfLines={1}
              className={cn("shrink text-xs font-t3-medium", SUBAGENT_TONE_TEXT_CLASS[status.tone])}
            >
              {status.label}
            </Text>
          </View>
          {thread === undefined ? null : (
            <>
              <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
                {relativeTime(thread.updatedAt)}
              </Text>
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
            </>
          )}
        </View>
        {renamedSeat === null ? null : (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            Seat {renamedSeat}
          </Text>
        )}
      </View>
    </View>
  );
  // A seat the client holds no thread for is listed, not opened: there may be no thread.
  if (thread === undefined)
    return (
      <View accessible className="border-b border-border">
        {row}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen({ environmentId: props.environmentId, threadId: thread.id })}
      className="border-b border-border active:opacity-70"
    >
      {row}
    </Pressable>
  );
}
