import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PlaybookCheckpoint } from "@t3tools/contracts/j5";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const calls = vi.hoisted(() => ({ answer: vi.fn(), refresh: vi.fn() }));
vi.mock("../state", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const writer = Atom.make("collaborator");
  const viewer = Atom.make("viewer");
  const ownerAccess = Atom.make({ kind: "person", owner: true });
  const writerAccess = Atom.make({ kind: "person", owner: false });
  return {
    j5Environment: {
      answerPlaybookCheckpoint: { permissionAtom: () => allowed, run: calls.answer },
    },
    j5Sharing: {
      connectionAccess: (environmentId: string) =>
        environmentId === "owner" ? ownerAccess : writerAccess,
      threadLevel: (environmentId: string) => (environmentId === "read-only" ? viewer : writer),
    },
    playbookCheckpointsQueryAtom: () => Atom.make(null),
    playbookCheckpointSourcesAtom: Atom.make({ sources: [] }),
    refreshJ5Sources: calls.refresh,
  };
});
vi.mock("../../state/entities", () => ({ useThreadShell: () => ({ title: "Release owner" }) }));
import { PlaybookCheckpointCard } from "./PlaybookCheckpointCard";

const checkpoint: PlaybookCheckpoint = {
  requestId: "checkpoint:1",
  runId: "run:1",
  ownerThreadId: ThreadId.make("owner"),
  stepId: "plan",
  stepTitle: "Review plan",
  summary: "The rollout and rollback plan is ready.",
  status: "pending",
  createdAt: "2026-11-17T00:00:00Z",
  answeredAt: null,
  reason: null,
};
const setup = () => {
  calls.answer.mockReset().mockResolvedValue({ _tag: "Success", value: checkpoint });
  calls.refresh.mockReset().mockResolvedValue(undefined);
};

it("a Collaborator declines the shared checkpoint with a reason and refreshes its source", async () => {
  setup();
  const environmentId = EnvironmentId.make("writeable");
  await using screen = await render(
    <PlaybookCheckpointCard request={checkpoint} environmentId={environmentId} />,
  );
  await expect.element(screen.getByText(checkpoint.summary)).toBeVisible();
  await userEvent.fill(screen.getByRole("textbox"), "Include rollback evidence.");
  await userEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
  expect(calls.answer).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: {
      threadId: checkpoint.ownerThreadId,
      requestId: checkpoint.requestId,
      decision: "decline",
      reason: "Include rollback evidence.",
    },
  });
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  expect(calls.refresh).toHaveBeenCalled();
});

it("Viewers and disconnected clients can read but cannot answer", async () => {
  setup();
  await using screen = await render(
    <PlaybookCheckpointCard request={checkpoint} environmentId={EnvironmentId.make("read-only")} />,
  );
  await expect.element(screen.getByText(checkpoint.summary)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Decline", exact: true })).toBeDisabled();
  await screen.rerender(
    <PlaybookCheckpointCard
      request={checkpoint}
      environmentId={EnvironmentId.make("writeable")}
      connected={false}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  expect(calls.answer).not.toHaveBeenCalled();
});

it("only a server Owner can approve the grouped persona picks", async () => {
  setup();
  const request = { ...checkpoint, kind: "persona_picks" as const };
  await using screen = await render(
    <PlaybookCheckpointCard request={request} environmentId={EnvironmentId.make("writeable")} />,
  );
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Decline", exact: true })).toBeEnabled();
  const environmentId = EnvironmentId.make("owner");
  await screen.rerender(<PlaybookCheckpointCard request={request} environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Approve", exact: true }));
  expect(calls.answer).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: { threadId: request.ownerThreadId, requestId: request.requestId, decision: "approve" },
  });
});
