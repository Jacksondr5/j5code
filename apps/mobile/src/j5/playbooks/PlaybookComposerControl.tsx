import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { j5Environment } from "../state";
import { usePlaybookRefresh } from "./usePlaybookRefresh";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";

export function PlaybookComposerControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const focused = useIsFocused();
  const runtime = useRemoteEnvironmentRuntime(props.environmentId);
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  // A guest is shown none of a server's Playbooks (Shared server AC24), so none is read.
  const guest = useGuestEnvironmentIds().has(props.environmentId);
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const supported = !guest && j5LedgerSupported(serverConfig) !== false;
  const query = useEnvironmentQuery(
    supported
      ? j5Environment.playbooks({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const [expanded, setExpanded] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const changes = useEnvironmentQuery(
    focused && query.data
      ? j5Environment.playbookChanges({ environmentId: props.environmentId, input: {} })
      : null,
  );
  usePlaybookRefresh({
    focused,
    connected: runtime?.connectionState === "connected",
    supported,
    isPending: query.isPending,
    refreshKey: `${thread?.latestRun?.runId}:${thread?.latestRun?.status}:${changes.data}`,
    refresh: query.refresh,
  });
  const runs = query.data?.runs ?? [];
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <View className="px-4 pb-2" accessibilityLabel="Playbook progress">
      <View className="rounded-[20px] border-continuous bg-card px-3 py-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${run.title}. ${display.status}. ${display.position}. ${display.currentTitle}${query.error ? ". Progress out of date" : ""}${run.runId !== runs[0]?.runId ? ". Earlier run" : ""}`}
          onPress={() => setExpanded(!expanded)}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView
            name={run.issue || query.error ? "exclamationmark.triangle" : "doc.text"}
            size={14}
            tintColorClassName="accent-icon-muted"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs text-foreground">
              {run.title}
            </Text>
            {(run.status !== "active" ||
              run.issue ||
              query.error ||
              run.runId !== runs[0]?.runId) && (
              <Text className="text-xs text-foreground-muted">
                {run.runId !== runs[0]?.runId ? "Earlier run · " : ""}
                {query.error ? "Out of date" : display.status}
              </Text>
            )}
          </View>
          <View className="items-end gap-1">
            <Text
              className={`text-xs ${run.status === "completed" ? "text-success" : "text-foreground-muted"}`}
            >
              {run.position ?? "?"}/{run.total}
            </Text>
            {display.steps.length > 1 && display.steps.length <= 10 && (
              <View
                className="w-10 flex-row gap-0.5"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {display.steps.map((step) => (
                  <View
                    key={step.id}
                    className={`h-[3px] min-w-0 flex-1 rounded-full ${
                      run.status === "completed" &&
                      (step.state === "earlier" || step.state === "last")
                        ? "bg-success"
                        : step.current
                          ? "bg-primary"
                          : step.state === "earlier"
                            ? "bg-primary/35"
                            : step.state === "last"
                              ? "bg-foreground-muted/60"
                              : "bg-subtle-strong"
                    }`}
                  />
                ))}
              </View>
            )}
          </View>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        {expanded && (
          <ScrollView className="max-h-48" nestedScrollEnabled accessibilityLabel="Playbook stages">
            <Text className="my-2 text-xs font-t3-medium text-foreground">{run.title}</Text>
            {runs.length > 1 && (
              <ScrollView horizontal className="my-2" accessibilityLabel="Playbook runs">
                {runs.map((entry, index) => (
                  <Pressable
                    key={entry.runId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: entry.runId === run.runId }}
                    onPress={() => setSelectedRunId(entry.runId)}
                    className="mr-3 min-h-11 justify-center rounded border border-border p-2"
                  >
                    <Text className="text-xs text-foreground">
                      {index === 0 ? "Latest: " : ""}
                      {entry.title} · {entry.status} · {new Date(entry.createdAt).toLocaleString()}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {run.description && (
              <Text className="my-2 text-xs text-foreground-muted">{run.description}</Text>
            )}
            {query.error && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                Progress could not refresh. Showing the last received state.
              </Text>
            )}
            {run.issue && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                {run.issue.message}
              </Text>
            )}
            {display.steps.map((step, index) => (
              <View key={step.id} className="flex-row items-start gap-2 py-2">
                <Text
                  className={`min-w-0 flex-1 text-sm ${step.current ? "font-t3-medium text-foreground" : "text-foreground-muted"}`}
                >
                  {index + 1}. {step.title}
                </Text>
                <Text className="text-xs text-foreground-muted">{step.label}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
