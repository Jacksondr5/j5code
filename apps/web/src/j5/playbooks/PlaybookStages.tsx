import {
  type PlaybookStagesView,
  playbookRunSelection,
  playbookStagesView,
  presentPlaybook,
  rememberPlaybookStagesView,
  selectedPlaybookRun,
} from "@t3tools/client-runtime/j5/playbooks";
import type { PlaybookProgress } from "@t3tools/contracts/j5";
import { AlertTriangleIcon, BookOpenIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { useId, useState } from "react";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";

/** A compact Tasks-style view of the playbook's live stage progress. */
export function PlaybookStages({
  runs,
  stale,
  viewKey,
}: {
  runs: readonly PlaybookProgress[];
  stale: boolean;
  /** The thread the bar belongs to, so its view survives being hidden for a question. */
  viewKey: string;
}) {
  const [view, setViewState] = useState(() => playbookStagesView(viewKey));
  const setView = (next: PlaybookStagesView) => {
    rememberPlaybookStagesView(viewKey, next);
    setViewState(next);
  };
  const { expanded } = view;
  const contentId = useId();
  const run = selectedPlaybookRun(runs, view.selectedRunId);
  if (!run) return null;
  const display = presentPlaybook(run);
  const historical = run.runId !== runs[0]?.runId;
  const warning = stale;
  const runItems = runs.map((entry, index) => ({
    value: entry.runId,
    label: `${index === 0 ? "Latest: " : ""}${entry.title} · ${entry.status} · ${new Date(entry.createdAt).toLocaleString()}`,
  }));
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" variant={warning ? "warning" : "default"}>
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-expanded={expanded}
          aria-controls={expanded ? contentId : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} playbook: ${run.title}. ${display.status}. ${display.headline}${display.flags.length ? `. ${display.flags.join(". ")}` : ""}${historical ? ". Earlier run" : ""}${stale ? ". Progress out of date" : ""}`}
          onClick={() => setView({ ...view, expanded: !expanded })}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ComposerBanner.Icon>
            {warning ? <AlertTriangleIcon /> : <BookOpenIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
              {display.headline}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {historical && (
              <span className="hidden text-muted-foreground @min-[400px]:inline">History</span>
            )}
            {stale ? (
              <span className="text-warning">Out of date</span>
            ) : run.status !== "active" ? (
              <span
                className={
                  warning
                    ? "text-warning"
                    : run.status === "completed"
                      ? "text-success"
                      : "text-muted-foreground"
                }
              >
                {display.status}
              </span>
            ) : null}
            {display.flags.map((flag) => (
              <span key={flag} className="text-warning">
                {flag}
              </span>
            ))}
            {display.steps.length > 1 && display.steps.length <= 10 && (
              <span
                aria-hidden
                className="hidden w-20 shrink-0 items-center gap-0.5 @min-[560px]:flex"
              >
                {display.steps.map((step) => (
                  <span
                    key={step.id}
                    className={cn(
                      "h-[3px] min-w-0 flex-1 rounded-full",
                      step.state === "earlier"
                        ? "bg-muted-foreground/40"
                        : step.current
                          ? "bg-primary"
                          : "bg-muted-foreground/25",
                    )}
                  />
                ))}
              </span>
            )}
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded && (
          <ComposerBanner.Scroll
            id={contentId}
            role="region"
            aria-label="Playbook stages"
            className="max-h-[min(16rem,30dvh)]"
          >
            <ComposerBanner.Body>
              <p className="my-2 font-medium">{run.title}</p>
              {display.holder && <p className="my-2 text-muted-foreground">{display.holder}</p>}
              {runs.length > 1 && (
                <div className="my-2 pe-2">
                  <Select
                    items={runItems}
                    value={run.runId}
                    onValueChange={(runId) =>
                      runId &&
                      setView({ ...view, selectedRunId: playbookRunSelection(runs, runId) })
                    }
                  >
                    <SelectTrigger size="xs" aria-label="Playbook run">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {runItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              )}
              {stale && (
                <p role="status" className="my-2 text-warning">
                  Progress could not refresh. Showing the last received state.
                </p>
              )}
              {run.checkpointSummary && (
                <p className="my-2 whitespace-pre-wrap text-muted-foreground">
                  Submitted for approval: {run.checkpointSummary}
                </p>
              )}
              {display.revisionHistory && (
                <p className="my-2 text-muted-foreground">{display.revisionHistory}</p>
              )}
              {display.cancelReason && (
                <p role="status" className="my-2 text-warning">
                  {display.cancelReason}
                </p>
              )}
            </ComposerBanner.Body>
            {display.steps.length > 0 && (
              <ComposerBanner.Children render={<ol />} aria-label="Playbook stage list">
                {display.steps.map((step, index) => (
                  <ComposerBanner.Row
                    key={step.id}
                    render={<li />}
                    className="items-start py-1 pe-2"
                    aria-current={step.current ? "step" : undefined}
                  >
                    <ComposerBanner.Icon
                      className={cn(
                        "h-4",
                        step.state === "earlier"
                          ? "text-muted-foreground/55"
                          : step.current
                            ? "text-primary"
                            : "text-muted-foreground/40",
                      )}
                    >
                      {step.current ? <CircleDotIcon /> : <CircleIcon />}
                    </ComposerBanner.Icon>
                    <ComposerBanner.Content
                      className={cn(
                        "block wrap-anywhere",
                        step.state === "earlier"
                          ? "text-muted-foreground/55"
                          : step.current
                            ? "text-foreground/90"
                            : "text-muted-foreground/70",
                      )}
                    >
                      <span className="sr-only">{step.label}: </span>
                      {index + 1}. {step.title}
                    </ComposerBanner.Content>
                  </ComposerBanner.Row>
                ))}
              </ComposerBanner.Children>
            )}
          </ComposerBanner.Scroll>
        )}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
