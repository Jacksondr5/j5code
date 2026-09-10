import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { RunDetailTab } from "./runsSearch";
import { WorkflowRunOverview } from "./WorkflowRunOverview";
import { WorkflowTimeline } from "./WorkflowTimeline";

interface WorkflowRunDetailProps {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly revealApproval?: boolean | undefined;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  readonly layout?: "wide" | "stacked" | undefined;
  readonly tab?: RunDetailTab | undefined;
  readonly onTabChange?: ((tab: RunDetailTab) => void) | undefined;
}

export default function WorkflowRunDetail(props: WorkflowRunDetailProps) {
  return <WorkflowRunDetailForRun {...props} key={props.runId} />;
}

function WorkflowRunDetailForRun({
  environmentId,
  runId,
  revealApproval = false,
  onOpenThread,
  layout = "wide",
  tab,
  onTabChange,
}: WorkflowRunDetailProps) {
  const [internalTab, setInternalTab] = useState<RunDetailTab>("overview");
  const selectedTab = revealApproval ? "overview" : (tab ?? internalTab);
  const selectTab = (next: RunDetailTab) => {
    if (tab === undefined) setInternalTab(next);
    onTabChange?.(next);
  };
  return (
    <section className="min-w-0 space-y-4">
      <div aria-label="Workflow detail" className="flex gap-1 border-b" role="tablist">
        {(["overview", "timeline"] as const).map((value) => (
          <button
            aria-controls={`workflow-${value}`}
            aria-selected={selectedTab === value}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              selectedTab === value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
            id={`workflow-${value}-tab`}
            key={value}
            onClick={() => selectTab(value)}
            role="tab"
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`workflow-${selectedTab}-tab`}
        id={`workflow-${selectedTab}`}
        role="tabpanel"
      >
        {selectedTab === "overview" ? (
          <WorkflowRunOverview
            environmentId={environmentId}
            onOpenThread={onOpenThread}
            revealApproval={revealApproval}
            runId={runId}
          />
        ) : (
          <WorkflowTimeline environmentId={environmentId} layout={layout} runId={runId} />
        )}
      </div>
    </section>
  );
}
