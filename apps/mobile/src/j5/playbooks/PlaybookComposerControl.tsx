import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybook,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
} from "@t3tools/client-runtime/j5/playbooks";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { j5Environment } from "../state";
import { usePlaybookRefresh } from "./usePlaybookRefresh";

export function PlaybookComposerControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const focused = useIsFocused();
  const runtime = useRemoteEnvironmentRuntime(props.environmentId);
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  // A thread's Playbook runs are part of the thread, so anyone who reads it reads them.
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const supported = j5LedgerSupported(serverConfig) !== false;
  const query = useEnvironmentQuery(
    supported
      ? j5Environment.playbooks({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  // The thread screen unmounts this bar while a question or approval is pending.
  const viewKey = `${props.environmentId}:${props.threadId}`;
  const [view, setViewState] = useState(() => playbookStagesView(viewKey));
  const setView = (next: PlaybookStagesView) => {
    rememberPlaybookStagesView(viewKey, next);
    setViewState(next);
  };
  const { expanded } = view;
  usePlaybookRefresh({
    focused,
    connected: runtime?.connectionState === "connected",
    supported,
    isPending: query.isPending,
    refreshKey: `${thread?.latestRun?.runId}:${thread?.latestRun?.status}`,
    refresh: query.refresh,
  });
  const runs = query.data?.runs ?? [];
  const run = selectedPlaybookRun(runs, view.selectedRunId);
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <View className="px-4 pb-2" accessibilityLabel="Playbook progress">
      <View className="rounded-[20px] border-continuous bg-card px-3 py-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${run.title}. ${display.status}. ${display.headline}${display.flags.length ? `. ${display.flags.join(". ")}` : ""}${query.error ? ". Progress out of date" : ""}${run.runId !== runs[0]?.runId ? ". Earlier run" : ""}`}
          onPress={() => setView({ ...view, expanded: !expanded })}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView
            name={query.error ? "exclamationmark.triangle" : "doc.text"}
            size={14}
            tintColorClassName="accent-icon-muted"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs text-foreground">
              {display.headline}
            </Text>
            {(run.status !== "active" || query.error || run.runId !== runs[0]?.runId) && (
              <Text className="text-xs text-foreground-muted">
                {run.runId !== runs[0]?.runId ? "Earlier run · " : ""}
                {query.error ? "Out of date" : display.status}
              </Text>
            )}
            {display.flags.map((flag) => (
              <Text key={flag} className="text-xs text-foreground-muted">
                {flag}
              </Text>
            ))}
          </View>
          <View className="items-end gap-1">
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
                      step.state === "earlier"
                        ? "bg-foreground-muted/40"
                        : step.current
                          ? "bg-primary"
                          : "bg-foreground-muted/25"
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
            <Text className="my-2 text-xs text-foreground">{run.title}</Text>
            {display.holder && (
              <Text className="my-2 text-xs text-foreground-muted">{display.holder}</Text>
            )}
            {runs.length > 1 && (
              <ScrollView horizontal className="my-2" accessibilityLabel="Playbook runs">
                {runs.map((entry, index) => (
                  <Pressable
                    key={entry.runId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: entry.runId === run.runId }}
                    onPress={() =>
                      setView({ ...view, selectedRunId: playbookRunSelection(runs, entry.runId) })
                    }
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
            {query.error && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                Progress could not refresh. Showing the last received state.
              </Text>
            )}
            {display.revisionHistory && (
              <Text className="my-2 text-xs text-foreground-muted">{display.revisionHistory}</Text>
            )}
            {run.cancelReason && (
              <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
                {run.cancelReason}
              </Text>
            )}
            {display.steps.map((step, index) => (
              <View
                key={step.id}
                accessible
                accessibilityLabel={`${index + 1}. ${step.title}, ${step.label}`}
                className="flex-row items-start gap-2 py-1"
              >
                <View className="h-4 w-6 items-center justify-center">
                  {step.current ? (
                    <View className="size-3 items-center justify-center rounded-full border border-primary">
                      <View className="size-1 rounded-full bg-primary" />
                    </View>
                  ) : (
                    <View className={step.state === "earlier" ? undefined : "opacity-40"}>
                      <SymbolView
                        name="circle"
                        size={12}
                        tintColorClassName="accent-foreground-muted"
                      />
                    </View>
                  )}
                </View>
                <Text
                  className={`min-w-0 flex-1 text-xs ${step.state === "earlier" ? "text-foreground-muted/55" : step.current ? "text-foreground/90" : "text-foreground-muted/70"}`}
                >
                  {index + 1}. {step.title}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
