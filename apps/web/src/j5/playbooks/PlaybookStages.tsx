import { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
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

/** Stage positions are navigable; an earlier position does not mean its work is complete. */
export function PlaybookStages({
  runs,
  stale,
}: {
  runs: readonly PlaybookProgress[];
  stale: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const contentId = useId();
  const run = runs.find((entry) => entry.runId === selectedRunId) ?? runs[0];
  if (!run) return null;
  const display = presentPlaybook(run);
  const historical = run.runId !== runs[0]?.runId;
  const warning = stale || Boolean(run.issue);
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
          aria-label={`${expanded ? "Collapse" : "Expand"} playbook: ${run.title}. ${display.status}. ${display.position}. ${display.currentTitle}${historical ? ". Earlier run" : ""}${stale ? ". Progress out of date" : ""}`}
          onClick={() => setExpanded(!expanded)}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ComposerBanner.Icon>
            {warning ? <AlertTriangleIcon /> : <BookOpenIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 text-muted-foreground">Playbook</span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
              {run.title} · {display.currentTitle}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {historical && <span className="text-muted-foreground">History</span>}
            {stale ? (
              <span className="text-warning">Out of date</span>
            ) : run.status !== "active" || run.issue ? (
              <span className={warning ? "text-warning" : "text-muted-foreground"}>
                {display.status}
              </span>
            ) : null}
            <ComposerBanner.Count aria-label={display.position}>
              <span className="sr-only">Stage </span>
              {run.position ?? "?"}/{run.total}
            </ComposerBanner.Count>
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
              <p className="my-2 wrap-anywhere font-medium">{run.title}</p>
              {runs.length > 1 && (
                <div className="my-2 pe-2">
                  <Select items={runItems} value={run.runId} onValueChange={setSelectedRunId}>
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
              {run.description && <p className="my-2 text-muted-foreground">{run.description}</p>}
              {stale && (
                <p role="status" className="my-2 text-warning">
                  Progress could not refresh. Showing the last received state.
                </p>
              )}
              {run.issue && (
                <p role="status" className="my-2 text-warning">
                  {run.issue.message}
                </p>
              )}
            </ComposerBanner.Body>
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
                      step.current ? "text-primary" : "text-muted-foreground/40",
                    )}
                  >
                    {step.current || step.state === "last" ? <CircleDotIcon /> : <CircleIcon />}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content
                    className={cn(
                      "block wrap-anywhere",
                      step.current ? "text-foreground/90" : "text-muted-foreground/70",
                    )}
                  >
                    {index + 1}. {step.title}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    <span className="text-muted-foreground">{step.label}</span>
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        )}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
