import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybookStages,
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
import { J5_CARD_CHROME, J5CardEyebrow } from "../components/J5Card";
import { j5Environment } from "../state";
import { usePlaybookRefresh } from "./usePlaybookRefresh";

/**
 * The thread's running Playbook, for its carousel: null once no run is active, so the card leaves
 * when its run completes (D9). The expanded steps keep the run the person picked across the
 * moments the composer unmounts the carousel.
 */
export function usePlaybookCard(environmentId: EnvironmentId, threadId: ThreadId) {
  const focused = useIsFocused();
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  // A thread's Playbook runs are part of the thread, so anyone who reads it reads them.
  const supported = j5LedgerSupported(useEnvironmentServerConfig(environmentId)) !== false;
  const query = useEnvironmentQuery(
    supported ? j5Environment.playbooks({ environmentId, input: { threadId } }) : null,
  );
  const viewKey = `${environmentId}:${threadId}`;
  const [view, setViewState] = useState(() => playbookStagesView(viewKey));
  const setView = (next: PlaybookStagesView) => {
    rememberPlaybookStagesView(viewKey, next);
    setViewState(next);
  };
  const changes = useEnvironmentQuery(
    focused && query.data ? j5Environment.playbookChanges({ environmentId, input: {} }) : null,
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
  const active = runs.find((run) => run.status === "active");
  // A run that ends folds its card, so the next run's card starts folded.
  if (active === undefined && query.data !== undefined && view.expanded) {
    setView({ ...view, expanded: false });
  }
  if (active === undefined) return null;
  return {
    active,
    runs,
    shown: selectedPlaybookRun(runs, view.selectedRunId) ?? active,
    outOfDate: query.error !== null && query.error !== undefined,
    view,
    setView,
  };
}

export type PlaybookCardState = NonNullable<ReturnType<typeof usePlaybookCard>>;

function StepSegments(props: { readonly run: PlaybookCardState["active"] }) {
  const { steps } = presentPlaybookStages(props.run);
  if (steps.length < 2 || steps.length > 10) return null;
  return (
    <View
      className="ml-1 w-10 flex-row gap-0.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {steps.map((step) => (
        <View
          key={step.id}
          className={`h-[3px] min-w-0 flex-1 rounded-full ${
            step.status === "completed"
              ? "bg-adaptive-emerald-600-400"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-foreground-muted/25"
          }`}
        />
      ))}
    </View>
  );
}

const positionLine = (card: PlaybookCardState, run: PlaybookCardState["active"]) =>
  card.outOfDate
    ? "Out of date"
    : run.issue
      ? "Needs attention"
      : presentPlaybookStages(run).position;

/** "PLAYBOOK · Step 2 of 4" and its segments, then "‹title› · ‹current step›" (D10). */
function PlaybookFaceRows(props: {
  readonly card: PlaybookCardState;
  readonly run: PlaybookCardState["active"];
}) {
  const { run } = props;
  return (
    <>
      <View className="h-4 flex-row items-center gap-1.5">
        <J5CardEyebrow label="Playbook" />
        <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
          · {positionLine(props.card, run)}
        </Text>
        <StepSegments run={run} />
      </View>
      <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
        {run.title}
        <Text className="text-sm font-sans text-foreground-secondary">
          {" "}
          · {presentPlaybookStages(run).currentTitle}
        </Text>
      </Text>
    </>
  );
}

export function PlaybookCardFace(props: { readonly card: PlaybookCardState }) {
  return <PlaybookFaceRows card={props.card} run={props.card.active} />;
}

export const playbookCardLabel = (card: PlaybookCardState) => {
  const display = presentPlaybookStages(card.active);
  return `Playbook ${card.active.title}. ${positionLine(card, card.active)}. ${display.currentTitle}`;
};

/** The expanded Playbook card: alone in the row, its steps under the folded face. */
export function PlaybookSteps(props: {
  readonly card: PlaybookCardState;
  readonly onFold: () => void;
}) {
  const { card } = props;
  const { runs, shown: run, view } = card;
  const display = presentPlaybookStages(run);
  return (
    <View className="px-4 pb-3" accessibilityLabel="Playbook progress">
      <View className={`${J5_CARD_CHROME} px-4 pb-2.5 pt-[5.25px]`}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          accessibilityLabel={`Fold playbook ${run.title}`}
          onPress={props.onFold}
          className="min-h-[35px] justify-center active:opacity-70"
        >
          <PlaybookFaceRows card={card} run={run} />
        </Pressable>
        <ScrollView
          className="mt-2 max-h-48 border-t border-border-subtle pt-1.5"
          nestedScrollEnabled
          accessibilityLabel="Playbook stages"
        >
          {runs.length > 1 && (
            <ScrollView horizontal className="my-2" accessibilityLabel="Playbook runs">
              {runs.map((entry, index) => (
                <Pressable
                  key={entry.runId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: entry.runId === run.runId }}
                  onPress={() =>
                    card.setView({
                      ...view,
                      selectedRunId: playbookRunSelection(runs, entry.runId),
                    })
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
          {card.outOfDate && (
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
            <View
              key={step.id}
              accessible
              accessibilityLabel={`${index + 1}. ${step.title}, ${step.label}`}
              className="flex-row items-center gap-2 py-1"
            >
              <View className="h-4 w-6 items-center justify-center">
                {step.status === "inProgress" ? (
                  <View className="size-3 items-center justify-center rounded-full border border-primary">
                    <View className="size-1 rounded-full bg-primary" />
                  </View>
                ) : (
                  <View className={step.status === "completed" ? undefined : "opacity-40"}>
                    <SymbolView
                      name={step.status === "completed" ? "checkmark" : "circle"}
                      size={12}
                      tintColorClassName={
                        step.status === "completed"
                          ? "accent-adaptive-emerald-600-400"
                          : "accent-foreground-muted"
                      }
                    />
                  </View>
                )}
              </View>
              <Text
                className={`min-w-0 flex-1 text-xs ${step.status === "completed" ? "text-foreground-muted/55" : step.status === "inProgress" ? "font-t3-medium text-foreground/90" : "text-foreground-muted/70"}`}
              >
                {index + 1}. {step.title}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
