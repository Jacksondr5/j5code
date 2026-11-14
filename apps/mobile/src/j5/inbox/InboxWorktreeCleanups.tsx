import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  answeredAgeLabel,
  answerFailure,
  cleanupButtons,
  cleanupNeedsAttention,
  cleanupTitle,
  commitsAheadLabel,
  groupCleanupOutcomes,
  mergeWorktreeCleanupSources,
  orderCleanupRows,
  outcomeReason,
  outcomeSummary,
  pickedCleanupPaths,
  placeWorktreeCleanups,
  pullRequestLabel,
  type ScopedWorktreeCleanup,
  sliceCleanupRows,
  toggleCleanupPath,
  uncommittedFilesLabel,
  worktreeCleanupKey,
} from "@t3tools/client-runtime/j5/crew-worktree-cleanup";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Environment } from "../state";
import {
  decidedWorktreeCleanupSourcesAtom,
  readWorktreeCleanupSources,
  worktreeCleanupSourcesAtom,
} from "./inboxSources";

const UNAVAILABLE = "This environment is unavailable, or only an Owner of this server can answer.";

/**
 * An Owner's worktree cleanups, as web answers them. One answered on this device stays in place
 * with its result, as does one whose second answer was refused, until the Inbox is left; the
 * other decided ones go to the Answered shelf.
 */
export function useWorktreeCleanupInbox() {
  const open = mergeWorktreeCleanupSources(useAtomValue(worktreeCleanupSourcesAtom));
  const decided = mergeWorktreeCleanupSources(useAtomValue(decidedWorktreeCleanupSourcesAtom));
  // The answer's own item stands in until the decided read arrives; null is a refused answer.
  const [answeredHere, setAnsweredHere] = useState<
    ReadonlyMap<string, ScopedWorktreeCleanup | null>
  >(new Map());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const answerCleanup = useAtomCommand(j5Environment.answerCrewWorktreeCleanup, {
    reportFailure: false,
  });
  const answer = async (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => {
    const key = worktreeCleanupKey(item);
    setPendingKey(key);
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([errorKey]) => errorKey !== key)),
    );
    const result = await answerCleanup({
      environmentId: item.environmentId,
      input: { itemId: item.id, removePaths },
    });
    if (result._tag === "Success") {
      setAnsweredHere((current) => new Map(current).set(key, { ...item, ...result.value.item }));
    } else {
      const failure = answerFailure(squashAtomCommandFailure(result));
      setErrors((current) => ({ ...current, [key]: failure.message }));
      if (failure.alreadyAnswered) setAnsweredHere((current) => new Map(current).set(key, null));
    }
    await readWorktreeCleanupSources(item.environmentId);
    setPendingKey(null);
  };
  return {
    ...placeWorktreeCleanups({ open, decided, answeredHere }),
    pendingKey,
    errors,
    answer,
  };
}

export function WorktreeCleanupsSection(props: {
  readonly items: ReadonlyArray<ScopedWorktreeCleanup>;
  readonly pendingKey: string | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly onAnswer: (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => void;
  readonly showEnvironment: boolean;
}) {
  const projects = useProjects();
  if (props.items.length === 0) return null;
  return (
    <View className="gap-3">
      {props.items.map((item) => {
        const key = worktreeCleanupKey(item);
        return (
          <WorktreeCleanup
            key={key}
            item={item}
            projectTitle={
              projects.find(
                (project) =>
                  project.environmentId === item.environmentId && project.id === item.projectId,
              )?.title ?? null
            }
            showEnvironment={props.showEnvironment}
            pending={props.pendingKey === key}
            error={props.errors[key]}
            onAnswer={props.onAnswer}
          />
        );
      })}
    </View>
  );
}

function cleanupMeta(
  item: ScopedWorktreeCleanup,
  projectTitle: string | null,
  showEnvironment: boolean,
) {
  const since = item.status === "open" ? item.filedAt : item.decidedAt;
  const age = since === null ? null : relativeTime(since);
  return [
    "J5",
    projectTitle,
    showEnvironment || !item.connected
      ? `${showEnvironment ? item.environmentLabel : ""}${item.connected ? "" : showEnvironment ? " (offline)" : "offline"}`
      : null,
    age === null ? null : item.status === "open" ? `open ${age}` : answeredAgeLabel(age),
  ].filter((part): part is string => part !== null && part !== "");
}

function WorktreeCleanup(props: {
  readonly item: ScopedWorktreeCleanup;
  readonly projectTitle: string | null;
  readonly showEnvironment: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onAnswer: (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => void;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const title = cleanupTitle(item);
  const attention = cleanupNeedsAttention(item.entries);
  return (
    <View className="rounded-2xl border-continuous bg-card px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={item.status === "open" ? `FYI. ${title}` : title}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          {item.status === "open" ? (
            <Text className="text-xs font-t3-semibold uppercase text-foreground-muted">FYI</Text>
          ) : (
            <SymbolView
              name={attention ? "exclamationmark.triangle" : "checkmark.circle.fill"}
              size={14}
              tintColorClassName={attention ? "accent-warning-foreground" : "accent-icon"}
            />
          )}
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <Text className="text-base font-t3-semibold">{title}</Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {cleanupMeta(item, props.projectTitle, props.showEnvironment).join(" · ")}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 border-t border-border-subtle pt-3">
          {item.status === "open" ? (
            <OpenBody
              item={item}
              pending={props.pending}
              error={props.error}
              onAnswer={props.onAnswer}
            />
          ) : (
            <ResultBody item={item} error={props.error} />
          )}
        </View>
      ) : null}
    </View>
  );
}

function OpenBody(props: {
  readonly item: ScopedWorktreeCleanup;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onAnswer: (item: ScopedWorktreeCleanup, removePaths: ReadonlyArray<string>) => void;
}) {
  const { item } = props;
  const mayAnswer = useAtomValue(
    j5Environment.answerCrewWorktreeCleanup.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  const hold = !canAnswer || props.pending;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = sliceCleanupRows(orderCleanupRows(item.entries), showAll);
  const buttons = cleanupButtons(selected, item.entries);
  const removeSelected = () => {
    const paths = pickedCleanupPaths(selected, item.entries);
    const count = paths.length === 1 ? "this worktree" : `these ${paths.length} worktrees`;
    Dialog.confirm({
      title: paths.length === 1 ? "Remove 1 worktree?" : `Remove ${paths.length} worktrees?`,
      message: `Removing ${count} discards their uncommitted changes. Their branches are kept.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => props.onAnswer(item, paths),
    });
  };
  return (
    <>
      <Text className="text-sm text-foreground-secondary">
        Removing a worktree keeps its branch and discards its uncommitted changes.
      </Text>
      <View className="gap-1">
        {shown.map((entry) => {
          const picked = selected.has(entry.path);
          return (
            <Pressable
              key={entry.path}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: picked, disabled: hold }}
              accessibilityLabel={entry.threadTitle}
              disabled={hold}
              onPress={() => setSelected((current) => toggleCleanupPath(current, entry.path))}
              className="flex-row gap-3 py-1.5 active:opacity-70"
            >
              <SymbolView
                name={picked ? "checkmark.circle.fill" : "circle"}
                size={20}
                tintColorClassName={picked ? "accent-icon" : "accent-icon-muted"}
              />
              <EntryLines entry={entry} />
            </Pressable>
          );
        })}
      </View>
      {hidden > 0 ? (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setShowAll(true)}>
          <Text className="font-t3-medium text-sm text-foreground-secondary">
            Show {hidden} more
          </Text>
        </Pressable>
      ) : null}
      {props.error === undefined ? null : (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      )}
      {canAnswer ? null : <Text className="text-xs text-foreground-muted">{UNAVAILABLE}</Text>}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Keep all"
          size="compact"
          disabled={hold}
          onPress={() => props.onAnswer(item, [])}
        />
        <Button
          label="Select all"
          size="compact"
          disabled={hold || buttons.selectAllDisabled}
          onPress={() => setSelected(new Set(item.entries.map((entry) => entry.path)))}
        />
        <Button
          label={props.pending ? "Removing…" : buttons.removeLabel}
          size="compact"
          tone="danger"
          disabled={hold || buttons.removeDisabled}
          onPress={removeSelected}
        />
      </View>
    </>
  );
}

function EntryLines(props: { readonly entry: ScopedWorktreeCleanup["entries"][number] }) {
  const { entry } = props;
  return (
    <View className="min-w-0 flex-1 gap-0.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="flex-1 text-sm font-t3-medium">{entry.threadTitle}</Text>
        {entry.pullRequestUrl === null ? null : (
          <Pressable
            accessibilityRole="link"
            hitSlop={6}
            onPress={() =>
              entry.pullRequestUrl !== null &&
              void Linking.openURL(entry.pullRequestUrl).catch(() => undefined)
            }
          >
            <Text className="text-xs text-foreground-secondary underline">
              {pullRequestLabel(entry.pullRequestUrl)}
            </Text>
          </Pressable>
        )}
      </View>
      <Text selectable className="font-mono text-xs text-foreground-muted">
        {entry.branch ?? entry.path}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {uncommittedFilesLabel(entry.uncommittedFiles)} · {commitsAheadLabel(entry.commitsAhead)}
      </Text>
    </View>
  );
}

const GROUP_ICON: Record<
  ReturnType<typeof groupCleanupOutcomes>[number]["outcome"],
  { readonly name: AppSymbolName; readonly tint: string }
> = {
  removed: { name: "checkmark.circle.fill", tint: "accent-icon" },
  kept: { name: "minus", tint: "accent-icon-muted" },
  skipped: { name: "exclamationmark.triangle", tint: "accent-warning-foreground" },
  failed: { name: "xmark.circle.fill", tint: "accent-danger-foreground" },
};

function ResultBody(props: {
  readonly item: ScopedWorktreeCleanup;
  readonly error: string | undefined;
}) {
  return (
    <>
      {props.error === undefined ? null : (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">{outcomeSummary(props.item.entries)}</Text>
      {groupCleanupOutcomes(props.item.entries).map((group) => (
        <View key={group.outcome} className="gap-1">
          <View className="flex-row items-center gap-1.5">
            <SymbolView
              name={GROUP_ICON[group.outcome].name}
              size={14}
              tintColorClassName={GROUP_ICON[group.outcome].tint}
            />
            <Text className="text-xs font-t3-semibold">{group.label}</Text>
          </View>
          {group.rows.map((entry) => {
            const reason = outcomeReason(entry);
            return (
              <View key={entry.path} className="gap-0.5 border-t border-border-subtle py-1.5 pl-5">
                <Text className="text-sm">{entry.threadTitle}</Text>
                <Text selectable className="font-mono text-xs text-foreground-muted">
                  {entry.branch ?? entry.path}
                </Text>
                {reason === null ? null : (
                  <Text
                    selectable={entry.outcome === "failed"}
                    className={
                      entry.outcome === "failed"
                        ? "font-mono text-xs text-danger-foreground"
                        : "text-xs text-foreground-muted"
                    }
                  >
                    {reason}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </>
  );
}

/** A decided cleanup on the Answered shelf: its title, where it came from, and its counts. */
export function DecidedCleanupRow(props: {
  readonly item: ScopedWorktreeCleanup;
  readonly showEnvironment: boolean;
}) {
  const projects = useProjects();
  const projectTitle =
    projects.find(
      (project) =>
        project.environmentId === props.item.environmentId && project.id === props.item.projectId,
    )?.title ?? null;
  return (
    <View className="gap-1 rounded-2xl bg-card px-4 py-3">
      <Text className="text-sm font-t3-medium">{cleanupTitle(props.item)}</Text>
      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
        {cleanupMeta(props.item, projectTitle, props.showEnvironment).join(" · ")}
      </Text>
      <Text className="text-xs text-foreground-muted">{outcomeSummary(props.item.entries)}</Text>
    </View>
  );
}
