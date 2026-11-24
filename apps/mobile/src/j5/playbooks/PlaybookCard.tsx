import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybook,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
  stepsExpandedFor,
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
 * when its run completes (D9). The expanded steps and the run the person picked last across the
 * moments the composer unmounts the carousel, but steps stay expanded only for the run they were
 * opened on.
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
  usePlaybookRefresh({
    focused,
    connected: runtime?.connectionState === "connected",
    supported,
    isPending: query.isPending,
    refreshKey: `${thread?.latestRun?.runId}:${thread?.latestRun?.status}`,
    refresh: query.refresh,
  });
  const runs = query.data?.runs ?? [];
  const active = runs.find((run) => run.status === "active");
  if (active === undefined) return null;
  return {
    active,
    runs,
    shown: selectedPlaybookRun(runs, view.selectedRunId) ?? active,
    outOfDate: query.error !== null && query.error !== undefined,
    view,
    setView,
    expanded: stepsExpandedFor(view, active.runId),
    setExpanded: (expanded: boolean) =>
      setView({ ...view, expanded, expandedRunId: expanded ? active.runId : null }),
  };
}

export type PlaybookCardState = NonNullable<ReturnType<typeof usePlaybookCard>>;

function StepSegments(props: { readonly run: PlaybookCardState["active"] }) {
  const { steps } = presentPlaybook(props.run);
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
            step.state === "earlier"
              ? "bg-foreground-muted/40"
              : step.current
                ? "bg-primary"
                : "bg-foreground-muted/25"
          }`}
        />
      ))}
    </View>
  );
}

function cardStatus(card: PlaybookCardState, run: PlaybookCardState["active"]) {
  return card.outOfDate ? "Out of date" : run.issue ? "Needs attention" : null;
}

/** The carousel face shows the current position and any open requests. */
function PlaybookFaceRows(props: {
  readonly card: PlaybookCardState;
  readonly run: PlaybookCardState["active"];
}) {
  const { run } = props;
  const display = presentPlaybook(run);
  return (
    <>
      <View className="h-4 flex-row items-center gap-1.5">
        <J5CardEyebrow label="Playbook" />
        <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
          {[cardStatus(props.card, run), ...display.flags].filter(Boolean).join(" · ")}
        </Text>
        <StepSegments run={run} />
      </View>
      <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
        {display.headline}
      </Text>
    </>
  );
}

export function PlaybookCardFace(props: { readonly card: PlaybookCardState }) {
  return <PlaybookFaceRows card={props.card} run={props.card.active} />;
}

export const playbookCardLabel = (card: PlaybookCardState) => {
  const display = presentPlaybook(card.active);
  return ["Playbook", display.headline, ...display.flags, cardStatus(card, card.active)]
    .filter(Boolean)
    .join(". ");
};

/** The expanded Playbook card: alone in the row, its steps under the folded face. */
export function PlaybookSteps(props: {
  readonly card: PlaybookCardState;
  readonly onFold: () => void;
}) {
  const { card } = props;
  const { runs, shown: run, view } = card;
  const display = presentPlaybook(run);
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
          {run.checkpointSummary && (
            <Text className="my-2 text-xs text-foreground-muted">
              Submitted for approval: {run.checkpointSummary}
            </Text>
          )}
          {display.revisionHistory && (
            <Text className="my-2 text-xs text-foreground-muted">{display.revisionHistory}</Text>
          )}
          {display.cancelReason && (
            <Text accessibilityRole="alert" className="my-2 text-xs text-foreground-muted">
              {display.cancelReason}
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
                className={`min-w-0 flex-1 text-xs ${step.state === "earlier" ? "text-foreground-muted/55" : step.current ? "font-t3-medium text-foreground/90" : "text-foreground-muted/70"}`}
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
