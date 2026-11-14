import {
  cleanupTitle,
  commitsAheadLabel,
  orderCleanupRows,
  pullRequestLabel,
  type ScopedWorktreeCleanup,
  sliceCleanupRows,
  uncommittedFilesLabel,
  worktreeCleanupKey,
} from "@t3tools/client-runtime/j5/crew-worktree-cleanup";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";

/**
 * The worktrees a Crew's archive kept because they hold unfinished work, shown to an Owner as web
 * lists them. Keeping or removing them is done on web or desktop, so the phone only shows them.
 */
export function WorktreeCleanupsSection(props: {
  readonly items: ReadonlyArray<ScopedWorktreeCleanup>;
  readonly showEnvironment: boolean;
}) {
  const projects = useProjects();
  if (props.items.length === 0) return null;
  return (
    <View className="gap-3">
      {props.items.map((item) => (
        <WorktreeCleanup
          key={worktreeCleanupKey(item)}
          item={item}
          projectTitle={
            projects.find(
              (project) =>
                project.environmentId === item.environmentId && project.id === item.projectId,
            )?.title ?? null
          }
          showEnvironment={props.showEnvironment}
        />
      ))}
    </View>
  );
}

function WorktreeCleanup(props: {
  readonly item: ScopedWorktreeCleanup;
  readonly projectTitle: string | null;
  readonly showEnvironment: boolean;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = sliceCleanupRows(orderCleanupRows(item.entries), showAll);
  const title = cleanupTitle(item);
  const meta = [
    "J5",
    props.projectTitle,
    props.showEnvironment || !item.connected
      ? `${props.showEnvironment ? item.environmentLabel : ""}${item.connected ? "" : props.showEnvironment ? " (offline)" : "offline"}`
      : null,
    `open ${relativeTime(item.filedAt)}`,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <View className="rounded-2xl border-continuous bg-card px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`FYI. ${title}`}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-xs font-t3-semibold uppercase text-foreground-muted">FYI</Text>
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <Text className="text-base font-t3-semibold">{title}</Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {meta.join(" · ")}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 border-t border-border-subtle pt-3">
          <Text className="text-sm text-foreground-secondary">
            Removing a worktree keeps its branch and discards its uncommitted changes. Keep or
            remove them on web or desktop.
          </Text>
          <View className="gap-2.5">
            {shown.map((entry) => (
              <View key={entry.path} className="gap-0.5">
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
                  {uncommittedFilesLabel(entry.uncommittedFiles)} ·{" "}
                  {commitsAheadLabel(entry.commitsAhead)}
                </Text>
              </View>
            ))}
          </View>
          {hidden > 0 ? (
            <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setShowAll(true)}>
              <Text className="font-t3-medium text-sm text-foreground-secondary">
                Show {hidden} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
