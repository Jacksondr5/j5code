import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { PlaybookError, type PlaybookProgress } from "@t3tools/contracts/j5";
import { expandPlaybookPrompt, presentPlaybook, sortPlaybookRuns } from "./playbooks.ts";

describe("playbook composer expansion", () => {
  it.each([
    ["/playbook release", "Start playbook release"],
    ["  /playbook release.yaml  ", "Start playbook release.yaml"],
    ["/playbook", "List available playbooks and help me choose one to start."],
    ["Explain /playbook release", "Explain /playbook release"],
    ["/playbook release\nDo something else", "/playbook release\nDo something else"],
    ["/playbooks release", "/playbooks release"],
    ["/plan", "/plan"],
    ["", ""],
  ])("expands only a standalone playbook request: %s", (text, expected) => {
    expect(expandPlaybookPrompt(text)).toBe(expected);
  });
});

const run: PlaybookProgress = {
  runId: "run-a",
  ownerThreadId: ThreadId.make("thread-a"),
  definitionPath: "/workspace/.j5/playbooks/demo.yaml",
  currentStepId: "build",
  status: "active",
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-21T10:00:00Z",
  title: "Demo",
  description: "Do the work",
  steps: [
    { id: "research", title: "Research" },
    { id: "build", title: "Build" },
    { id: "review", title: "Review" },
  ],
  position: 2,
  total: 3,
  issue: null,
};
it("presents the current phase without inventing success for earlier steps", () => {
  const display = presentPlaybook(run);
  expect(display.position).toBe("Step 2 of 3");
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ label }) => label)).toEqual(["Earlier", "Current", "Later"]);
  expect(presentPlaybook({ ...run, status: "cancelled" })).toMatchObject({
    status: "Cancelled",
    steps: [{ label: "Earlier" }, { label: "Last position" }, { label: "Later" }],
  });
});
it("preserves the phase identity when live steps are reordered", () => {
  const display = presentPlaybook({
    ...run,
    steps: [run.steps[1]!, run.steps[2]!, run.steps[0]!],
    position: 1,
  });
  expect(display.currentTitle).toBe("Build");
  expect(display.steps.map(({ current }) => current)).toEqual([true, false, false]);
});

it.each(["completed", "cancelled"] as const)(
  "marks the last position without an active or successful step in a %s run",
  (status) => {
    const display = presentPlaybook({ ...run, status, currentStepId: "research", position: 1 });
    expect(display.steps.map(({ state }) => state)).toEqual(["last", "later", "later"]);
    expect(display.steps.some(({ current }) => current)).toBe(false);
    expect(display.steps[0]?.label).toBe("Last position");
  },
);

it("shows available steps without guessing progress when the live definition loses the current step", () => {
  const display = presentPlaybook({ ...run, currentStepId: "removed", position: null });
  expect(display.position).toBe("Step unavailable");
  expect(display.currentTitle).toBe("removed");
  expect(display.steps.every((step) => step.state === "available" && !step.current)).toBe(true);
  expect(presentPlaybook({ ...run, steps: [], position: null, total: 0 }).steps).toEqual([]);
});

it("moves positional highlighting back without treating later steps as completed", () => {
  const display = presentPlaybook({ ...run, currentStepId: "research", position: 1 });
  expect(display.steps.map(({ state }) => state)).toEqual(["current", "later", "later"]);
});

it("retains all 100 step names and identifies the current position by stable ID", () => {
  const steps = Array.from({ length: 100 }, (_, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
  }));
  const display = presentPlaybook({
    ...run,
    steps,
    total: 100,
    position: 50,
    currentStepId: "step-50",
  });
  expect(display.position).toBe("Step 50 of 100");
  expect(display.steps.map(({ id, title }) => ({ id, title }))).toEqual(steps);
  expect(display.steps.filter(({ current }) => current).map(({ id }) => id)).toEqual(["step-50"]);
  expect(display.steps[48]?.state).toBe("earlier");
  expect(display.steps[50]?.state).toBe("later");
});

it("prioritizes active issues, then active runs and recency, without changing the fetched page", () => {
  const issue = new PlaybookError({
    code: "step_missing",
    message: "Step removed",
    availableStepIds: [],
  });
  const runs = Object.freeze([
    { ...run, runId: "completed", status: "completed" as const, updatedAt: "2026-09-21T14:00:00Z" },
    { ...run, runId: "older-active" },
    {
      ...run,
      runId: "cancelled-issue",
      status: "cancelled" as const,
      issue,
      updatedAt: "2026-09-21T15:00:00Z",
    },
    { ...run, runId: "active-issue", issue },
    { ...run, runId: "recent-active", updatedAt: "2026-09-21T11:00:00Z" },
    { ...run, runId: "tied-active", updatedAt: "2026-09-21T11:00:00Z" },
  ]);
  const original = [...runs];
  expect(sortPlaybookRuns(runs).map(({ runId }) => runId)).toEqual([
    "active-issue",
    "recent-active",
    "tied-active",
    "older-active",
    "cancelled-issue",
    "completed",
  ]);
  expect(runs).toEqual(original);
  expect(sortPlaybookRuns([])).toEqual([]);
});
