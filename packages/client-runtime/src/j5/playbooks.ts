import type { PlaybookProgress } from "@t3tools/contracts/j5";

/** A composer text expansion. The ordinary agent-message path performs the work. */
export function expandPlaybookPrompt(text: string): string {
  return text.replace(
    /^\s*\/playbook(?:[ \t]+([^\r\n]+))?\s*$/i,
    (_match, name: string | undefined) =>
      name?.trim()
        ? `Start playbook ${name.trim()}`
        : "List available playbooks and help me choose one to start.",
  );
}

export function presentPlaybook(run: PlaybookProgress) {
  const current = run.steps.find((step) => step.id === run.currentStepId);
  return {
    status:
      run.status === "active"
        ? run.issue
          ? "Needs attention"
          : "In progress"
        : run.status === "completed"
          ? "Completed"
          : "Cancelled",
    position: run.position === null ? "Step unavailable" : `Step ${run.position} of ${run.total}`,
    currentTitle: current?.title ?? run.currentStepId,
    steps: run.steps.map((step, index) => {
      const state =
        step.id === run.currentStepId
          ? run.status === "active"
            ? "current"
            : "last"
          : run.position === null
            ? "available"
            : index + 1 < run.position
              ? "earlier"
              : "later";
      return {
        ...step,
        state,
        current: state === "current",
        label: {
          current: "Current",
          last: "Last position",
          available: "Available",
          earlier: "Earlier",
          later: "Later",
        }[state],
      } as const;
    }),
  };
}

/** Prioritize active runs with issues within a fetched page without mutating the query's runs. */
export function sortPlaybookRuns(runs: ReadonlyArray<PlaybookProgress>) {
  return runs.toSorted(
    (a, b) =>
      Number(b.status === "active" && !!b.issue) - Number(a.status === "active" && !!a.issue) ||
      Number(b.status === "active") - Number(a.status === "active") ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}
