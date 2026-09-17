import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, MonitorIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";
import {
  refreshSquadronDirectory,
  type ScopedManagedSquadron,
} from "../squadron/SquadronDirectory";
import {
  describeOnboardingFolderOutcome,
  eligibleExistingSquadrons,
  isOnboardingFolderComplete,
  resolveOnboardingAssignment,
  resolveOnboardingSquadronsReadiness,
  type OnboardingFolderOutcome,
  type OnboardingSquadronAssignment,
  type OnboardingSquadronHome,
} from "./onboardingSquadrons.logic";

const NEW_SQUADRON_VALUE = "new";

export interface OnboardingSquadronFolder {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly title: string;
  readonly path: string;
  /** Known only when the folder is already a registered project on its computer. */
  readonly projectId: ProjectId | null;
}

/**
 * Fourth onboarding stage. Lists only the folders chosen on Projects and asks which Squadron
 * owns each one's conversations. Nothing is created here; the final button hands the choices
 * back to the import run. After a run, each row shows its own result and the button retries
 * only what did not land.
 */
export function SquadronsStage({
  folders,
  squadrons,
  assignments,
  onAssignmentChange,
  homes,
  outcomes,
  isImporting,
  summary,
  onBack,
  onSkip,
  onImport,
}: {
  readonly folders: ReadonlyArray<OnboardingSquadronFolder>;
  /** The merged Squadron directory; rows filter it to their own folder. */
  readonly squadrons: ReadonlyArray<ScopedManagedSquadron>;
  readonly assignments: ReadonlyMap<string, OnboardingSquadronAssignment>;
  readonly onAssignmentChange: (key: string, assignment: OnboardingSquadronAssignment) => void;
  readonly homes: ReadonlyMap<string, OnboardingSquadronHome>;
  readonly outcomes: ReadonlyMap<string, OnboardingFolderOutcome>;
  readonly isImporting: boolean;
  /** Aggregate line from the run, shown under the rows. */
  readonly summary: string;
  readonly onBack: () => void;
  /** Finishes without importing, or without the rest once some folders landed. */
  readonly onSkip: () => void;
  readonly onImport: () => void;
}) {
  const showEnvironment = new Set(folders.map((folder) => folder.environmentId)).size > 1;
  const hasRun = folders.some((folder) => outcomes.has(folder.key));
  const allComplete =
    hasRun &&
    folders.every((folder) => {
      const outcome = outcomes.get(folder.key);
      return outcome !== undefined && isOnboardingFolderComplete(outcome);
    });
  const readiness = resolveOnboardingSquadronsReadiness(folders, assignments, homes);
  // The wizard panel animates its height with overflow hidden while this stage mounts. A plain
  // autoFocus scrolls that clipped container to reveal the button and hides the heading, so
  // focus the primary action once without scrolling.
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, []);
  // Existing Squadrons only matter on a reopened install; read them fresh on entry so the
  // choice reflects the servers, not a 30-second-old directory. Keyed by the set of
  // computers, not the folder array, so re-renders do not refetch.
  const environmentKey = [...new Set(folders.map((folder) => folder.environmentId))]
    .sort()
    .join("\n");
  useEffect(() => {
    for (const environmentId of environmentKey.split("\n")) {
      if (environmentId.length > 0) {
        void refreshSquadronDirectory({ environmentId: EnvironmentId.make(environmentId) });
      }
    }
  }, [environmentKey]);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Squadrons</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Give each folder a Squadron so its conversations have an owner.
      </p>
      <ScrollArea
        scrollFade
        className="mt-5 h-auto max-h-80 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <ul className="space-y-2 pr-3">
          {folders.map((folder) => {
            const home = homes.get(folder.key);
            const outcome = outcomes.get(folder.key);
            const assignment = resolveOnboardingAssignment(assignments, folder);
            const existing = eligibleExistingSquadrons(squadrons, folder);
            return (
              <li
                key={folder.key}
                className="rounded-lg border border-border bg-background px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{folder.title}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {folder.path}
                    </span>
                  </span>
                  {showEnvironment ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <MonitorIcon className="size-3" aria-hidden />
                      {folder.environmentLabel}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  {home !== undefined ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
                      <CheckIcon className="size-3.5 text-success-foreground" aria-hidden />
                      {home.name}
                    </span>
                  ) : (
                    <AssignmentControl
                      folder={folder}
                      assignment={assignment}
                      existing={existing}
                      disabled={isImporting}
                      onChange={(next) => onAssignmentChange(folder.key, next)}
                    />
                  )}
                </div>
                {outcome !== undefined ? <OutcomeLine outcome={outcome} /> : null}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      <p className="mt-3 text-xs text-muted-foreground">
        A conversation keeps its Squadron for good; you can add more Squadrons to a folder later.
      </p>
      {summary ? <p className="mt-3 text-sm text-destructive">{summary}</p> : null}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost-muted" disabled={isImporting} onClick={onBack}>
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {allComplete ? (
            // Everything landed but some rows report kept conversations; read, then continue.
            <Button ref={primaryRef} onClick={onSkip}>
              Continue
              <ArrowRightIcon className="size-3.5" />
            </Button>
          ) : (
            <>
              <Button variant="ghost-muted" disabled={isImporting} onClick={onSkip}>
                {hasRun ? "Continue without the rest" : "Do not import projects"}
              </Button>
              <Button
                ref={primaryRef}
                disabled={isImporting || readiness !== "ready"}
                onClick={onImport}
              >
                {isImporting
                  ? "Importing…"
                  : hasRun
                    ? "Retry"
                    : "Import projects and conversations"}
                {isImporting ? null : <ArrowRightIcon className="size-3.5" />}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function AssignmentControl({
  folder,
  assignment,
  existing,
  disabled,
  onChange,
}: {
  readonly folder: OnboardingSquadronFolder;
  readonly assignment: OnboardingSquadronAssignment;
  readonly existing: ReadonlyArray<{
    readonly squadron: { readonly id: string; readonly name: string };
  }>;
  readonly disabled: boolean;
  readonly onChange: (assignment: OnboardingSquadronAssignment) => void;
}) {
  const items = [
    { value: NEW_SQUADRON_VALUE, label: "New Squadron" },
    ...existing.map((entry) => ({ value: entry.squadron.id, label: entry.squadron.name })),
  ];
  if (assignment.kind === "unconfirmed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {existing.length > 0 ? (
          <ExistingSelect
            folder={folder}
            items={items.slice(1)}
            value={null}
            disabled={disabled}
            onChange={(squadronId) => onChange({ kind: "existing", squadronId })}
          />
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void refreshSquadronDirectory({ environmentId: folder.environmentId, force: true })
          }
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange({ kind: "new", name: assignment.name })}
        >
          Create it again
        </Button>
      </div>
    );
  }
  // An existing choice whose Squadron dropped out of the eligible list keeps its select, with
  // the placeholder showing, so the person can still pick New or another Squadron.
  const selectValue =
    assignment.kind === "new"
      ? NEW_SQUADRON_VALUE
      : existing.some((entry) => entry.squadron.id === assignment.squadronId)
        ? assignment.squadronId
        : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {existing.length > 0 || assignment.kind === "existing" ? (
        <ExistingSelect
          folder={folder}
          items={items}
          value={selectValue}
          disabled={disabled}
          onChange={(value) =>
            onChange(
              value === NEW_SQUADRON_VALUE
                ? { kind: "new", name: folder.title }
                : { kind: "existing", squadronId: value },
            )
          }
        />
      ) : null}
      {assignment.kind === "new" ? (
        <Input
          nativeInput
          size="sm"
          className={cn("min-w-0 flex-1", existing.length === 0 && "max-w-xs")}
          aria-label={`Squadron name for ${folder.title}`}
          aria-invalid={assignment.name.trim().length === 0}
          disabled={disabled}
          value={assignment.name}
          onChange={(event) => onChange({ kind: "new", name: event.currentTarget.value })}
        />
      ) : null}
    </div>
  );
}

function ExistingSelect({
  folder,
  items,
  value,
  disabled,
  onChange,
}: {
  readonly folder: OnboardingSquadronFolder;
  readonly items: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      modal={false}
      items={[...items]}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger size="sm" className="w-44" aria-label={`Squadron for ${folder.title}`}>
        <SelectValue placeholder="Choose a Squadron" />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function OutcomeLine({ outcome }: { readonly outcome: OnboardingFolderOutcome }) {
  const { headline, detail } = describeOnboardingFolderOutcome(outcome);
  const complete = isOnboardingFolderComplete(outcome);
  return (
    <p
      role="status"
      className={cn("mt-2 text-xs", complete ? "text-muted-foreground" : "text-destructive")}
    >
      {headline}
      {detail ? <span className="block text-muted-foreground">{detail}</span> : null}
    </p>
  );
}
