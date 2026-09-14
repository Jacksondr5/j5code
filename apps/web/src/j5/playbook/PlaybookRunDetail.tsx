import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { RunDetailTab } from "./runsSearch";
import { PlaybookRunOverview } from "./PlaybookRunOverview";
import { PlaybookTimeline } from "./PlaybookTimeline";

interface PlaybookRunDetailProps {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  readonly revealApproval?: boolean | undefined;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  readonly layout?: "wide" | "stacked" | undefined;
  readonly tab?: RunDetailTab | undefined;
  readonly onTabChange?: ((tab: RunDetailTab) => void) | undefined;
}

export default function PlaybookRunDetail(props: PlaybookRunDetailProps) {
  return <PlaybookRunDetailForRun {...props} key={props.runId} />;
}

function PlaybookRunDetailForRun({
  environmentId,
  runId,
  revealApproval = false,
  onOpenThread,
  layout = "wide",
  tab,
  onTabChange,
}: PlaybookRunDetailProps) {
  const [internalTab, setInternalTab] = useState<RunDetailTab>("overview");
  const selectedTab = revealApproval ? "overview" : (tab ?? internalTab);
  const selectTab = (next: RunDetailTab) => {
    if (tab === undefined) setInternalTab(next);
    onTabChange?.(next);
  };
  return (
    <section className="min-w-0 space-y-4">
      <div aria-label="Playbook detail" className="flex gap-1 border-b" role="tablist">
        {(["overview", "timeline"] as const).map((value) => (
          <button
            aria-controls={`playbook-${value}`}
            aria-selected={selectedTab === value}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              selectedTab === value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
            id={`playbook-${value}-tab`}
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
        aria-labelledby={`playbook-${selectedTab}-tab`}
        id={`playbook-${selectedTab}`}
        role="tabpanel"
      >
        {selectedTab === "overview" ? (
          <PlaybookRunOverview
            environmentId={environmentId}
            onOpenThread={onOpenThread}
            revealApproval={revealApproval}
            runId={runId}
          />
        ) : (
          <PlaybookTimeline environmentId={environmentId} layout={layout} runId={runId} />
        )}
      </div>
    </section>
  );
}
