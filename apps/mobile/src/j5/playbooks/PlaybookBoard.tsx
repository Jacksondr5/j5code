import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const environment = createJ5EnvironmentAtoms(connectionAtomRuntime);
const stepColor = {
  current: "bg-primary",
  last: "bg-foreground-muted/60",
  earlier: "bg-primary/35",
  later: "bg-subtle-strong",
  available: "bg-subtle-strong",
};

export function PlaybookBoard(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const focused = useIsFocused();
  const query = useEnvironmentQuery(
    environment.playbooks({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const [expanded, setExpanded] = useState(true);
  const [showSteps, setShowSteps] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { isPending, refresh: refreshQuery } = query;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (!isPending) refreshQuery();
    };
    const sync = () => {
      clearInterval(timer);
      if (focused && AppState.currentState === "active") timer = setInterval(refresh, 2_500);
    };
    const subscription = AppState.addEventListener("change", () => {
      sync();
      if (focused && AppState.currentState === "active") refresh();
    });
    sync();
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [focused, refreshQuery, isPending]);
  const runs = query.data?.runs ?? [];
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  return (
    <View
      className="border-b border-border bg-card px-4 py-3"
      accessibilityLabel="Playbook progress"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="font-semibold text-foreground">{run.title}</Text>
        <Text className="mt-1 text-xs text-foreground-muted">
          {display.status} · {display.position} · {display.currentTitle}
        </Text>
      </Pressable>
      {expanded && (
        <>
          {runs.length > 1 && (
            <ScrollView horizontal className="mt-2" accessibilityLabel="Playbook runs">
              {runs.map((entry, index) => (
                <Pressable
                  key={entry.runId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: entry.runId === run.runId }}
                  onPress={() => setSelectedRunId(entry.runId)}
                  className="mr-3 rounded border border-border p-2"
                >
                  <Text className="text-xs text-foreground">
                    {index === 0 ? "Latest" : entry.title} · {entry.status}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {query.error && (
            <Text accessibilityRole="alert" className="mt-2 text-xs text-foreground-muted">
              Progress could not refresh. Showing the last received state.
            </Text>
          )}
          {run.issue && (
            <Text accessibilityRole="alert" className="mt-2 text-xs text-foreground-muted">
              {run.issue.message}
            </Text>
          )}
          {display.steps.length > 0 && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${showSteps ? "Hide" : "Show"} all ${display.steps.length} steps`}
                accessibilityState={{ expanded: showSteps }}
                onPress={() => setShowSteps(!showSteps)}
                className="mt-2 min-h-11 justify-center gap-2 py-2"
              >
                <View
                  className="flex-row gap-px"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  {display.steps.map((step) => (
                    <View
                      key={step.id}
                      className={`h-2 min-w-0 flex-1 rounded-sm ${stepColor[step.state]}`}
                    />
                  ))}
                </View>
                <Text className="text-xs text-foreground-muted">
                  {showSteps ? "Hide steps" : "Show steps"}
                </Text>
              </Pressable>
              {showSteps && (
                <ScrollView
                  className="max-h-48"
                  nestedScrollEnabled
                  accessibilityLabel="Playbook steps"
                >
                  {display.steps.map((step, index) => (
                    <Text
                      key={step.id}
                      accessibilityLabel={`${index + 1}. ${step.title}, ${step.label}`}
                      className={`py-1 text-sm ${step.current ? "font-t3-medium text-foreground" : "text-foreground-muted"}`}
                    >
                      {index + 1} · {step.title}
                      {(step.current || step.state === "last") && ` · ${step.label}`}
                    </Text>
                  ))}
                </ScrollView>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
