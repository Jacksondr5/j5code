import { ThreadId } from "@t3tools/contracts";
import { type PlaybookProgress } from "@t3tools/contracts/j5";
import { expect, it } from "vite-plus/test";

import { act, render as renderUi } from "../../../test/render";
import { PlaybookStages } from "./PlaybookStages";

const active: PlaybookProgress = {
  runId: "latest",
  ownerThreadId: ThreadId.make("thread"),
  definitionPath: "/test/playbooks/release.yaml",
  currentStepId: "build",
  status: "active",
  createdAt: "2026-10-17T12:00:00Z",
  updatedAt: "2026-10-17T12:01:00Z",
  title: "Release",
  description: "Prepare a release together.",
  steps: [
    { id: "plan", title: "Plan the release" },
    { id: "build", title: "Build the change" },
    { id: "review", title: "Review the change" },
  ],
  position: 2,
  total: 3,
};

let viewKey = 0;

// Each test gets its own view key so a disclosure remembered by an earlier test is not reused.
async function mount() {
  viewKey += 1;
  const key = `env:thread-${viewKey}`;
  const screen = await renderUi(null, { router: false });
  const { container } = screen;
  return {
    screen,
    container,
    show: (runs: readonly PlaybookProgress[], stale = false) =>
      screen.rerender(<PlaybookStages runs={runs} stale={stale} viewKey={key} />),
    toggle: () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!,
    stages: () => container.querySelector('ol[aria-label="Playbook stage list"]'),
  };
}

function option(text: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((node) =>
    node.textContent?.includes(text),
  )!;
}

it("starts collapsed, follows pointer changes, and preserves disclosure when moving backward", async () => {
  const view = await mount();
  await using _screen = view.screen;
  const { container, show, toggle, stages } = view;
  await show([]);
  expect(container.textContent).toBe("");
  await show([active]);
  expect(toggle().textContent).toContain("Step 2 of 3 · Build the change");
  expect(toggle().getAttribute("aria-label")).toContain("Build the change");
  expect(stages()).toBeNull();

  await act(() => toggle().click());
  expect(stages()?.textContent).toContain("Earlier: 1. Plan the release");
  expect(stages()?.textContent).toContain("Current: 2. Build the change");
  expect(stages()?.textContent).toContain("Later: 3. Review the change");
  expect(toggle().textContent).toContain("Step 2 of 3 · Build the change");
  expect(container.querySelector('[aria-label="Playbook stages"]')?.textContent).not.toContain(
    active.description,
  );
  expect(container.querySelector('[aria-label="Playbook stages"]')?.textContent).toContain(
    active.title,
  );

  await show([{ ...active, currentStepId: "plan", position: 1 }]);
  expect(stages()?.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Plan the release",
  );
  expect(stages()?.textContent).toContain("Later: 2. Build the change");
  expect(toggle().textContent).toContain("Step 1 of 3 · Plan the release");
  await act(() => toggle().click());
  expect(stages()).toBeNull();
  await show([{ ...active, currentStepId: "review", position: 3 }]);
  expect(toggle().getAttribute("aria-label")).toContain("Step 3 of 3");
  expect(stages()).toBeNull();
});

it("keeps stale, unavailable, and terminal states visible while collapsed", async () => {
  const view = await mount();
  await using _screen = view.screen;
  const { container, show, toggle, stages } = view;
  await show([active], true);
  expect(toggle().textContent).toContain("Out of date");
  await act(() => toggle().click());
  expect(container.textContent).toContain("Showing the last received state");

  await show([
    {
      ...active,
      status: "cancelled",
      currentStepId: "legacy",
      position: null,
      total: 0,
      steps: [],
      cancelReason: "started before runs kept their own copy; start it again.",
    },
  ]);
  expect(container.textContent).toContain("started before runs kept their own copy");
  expect(stages()).toBeNull();
  await act(() => toggle().click());
  expect(toggle().textContent).toContain("Cancelled");
  expect(toggle().getAttribute("aria-label")).toContain("Last step: legacy");

  await show([{ ...active, status: "completed" }]);
  expect(toggle().textContent).toContain("Completed");
  expect(toggle().textContent).toContain("of 3");
  await act(() => toggle().click());
  expect(stages()?.textContent).toContain("Last position: 2. Build the change");
  expect(stages()?.querySelector('[aria-current="step"]')).toBeNull();
  await show([{ ...active, currentStepId: "review", position: 3, status: "completed" }]);
  expect(toggle().textContent).toContain("of 3");
  expect(stages()?.textContent).toContain("Last position: 3. Review the change");
  await act(() => toggle().click());
  await show([{ ...active, status: "cancelled" }]);
  expect(toggle().textContent).toContain("Cancelled");
});

it("inspects history without confusing it with the latest run, then returns to latest", async () => {
  const view = await mount();
  await using _screen = view.screen;
  const { container, show, toggle } = view;
  const previous = {
    ...active,
    runId: "previous",
    title: "Earlier release",
    status: "completed" as const,
  };
  await show([active, previous]);
  await act(() => toggle().click());
  const picker = () => container.querySelector<HTMLButtonElement>('[aria-label="Playbook run"]')!;
  await act(() => picker().click());
  const oldOption = option("Earlier release");
  await act(() => oldOption.click());
  expect(container.textContent).toContain("Earlier release");
  expect(toggle().textContent).toContain("History");
  await act(() => toggle().click());
  expect(toggle().getAttribute("aria-label")).toContain("Earlier run");
  await act(() => toggle().click());
  await act(() => picker().click());
  const latestOption = option("Latest:");
  await act(() => latestOption.click());
  expect(toggle().textContent).not.toContain("History");
  expect(toggle().textContent).toContain("Step 2 of 3 · Build the change");

  const next = { ...active, runId: "next", title: "Next release" };
  await show([next, active, previous]);
  expect(container.textContent).toContain("Next release");
  expect(toggle().textContent).not.toContain("History");
});

it("comes back expanded on the same run after the composer hides it for a question", async () => {
  const view = await mount();
  await using _screen = view.screen;
  const { container, show, toggle, stages } = view;
  const previous = { ...active, runId: "previous", title: "Earlier release" };
  await show([active, previous]);
  await act(() => toggle().click());
  await act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Playbook run"]')!.click(),
  );
  const oldOption = option("Earlier release");
  await act(() => oldOption.click());

  await view.screen.rerender(null);
  await show([active, previous]);
  expect(stages()).not.toBeNull();
  expect(container.textContent).toContain("Earlier release");
});
