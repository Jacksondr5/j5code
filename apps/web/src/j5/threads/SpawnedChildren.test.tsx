import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { SpawnedChildGroupRows } from "./SpawnedChildren";
import { groupSpawnedChildren, selectSpawnedChildRows } from "./spawnedChildren.logic";

const environmentId = EnvironmentId.make("environment:local");
const threadId = ThreadId.make("thread:builder");

const seatRow = (input: {
  readonly notStarted: boolean;
  readonly runtimeStatus?: "failed" | "interrupted";
}) => {
  const thread = {
    id: threadId,
    environmentId,
    title: "builder",
    updatedAt: "2026-10-27T12:00:00.000Z",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    ...(input.runtimeStatus === undefined
      ? {}
      : { runtime: { status: input.runtimeStatus, providerInstanceId: "codex" } }),
  } as unknown as EnvironmentThreadShell;
  const rows = selectSpawnedChildRows(
    [
      {
        threadId,
        participantId: "agent:j5:a2a:thread:builder",
        seat: {
          crewInstanceId: "crew:1",
          crewName: "Review Pair",
          seat: "builder",
          notStarted: input.notStarted,
        },
      },
    ],
    new Map([[threadId as string, thread]]),
  );
  const [group] = groupSpawnedChildren(rows);
  return renderToStaticMarkup(
    <SpawnedChildGroupRows
      environmentId={environmentId}
      group={group!}
      providerEntries={new Map()}
      isOpen
      onToggle={() => undefined}
      onOpen={() => undefined}
      renamingThreadKey={null}
      onContextMenu={() => undefined}
      onCommitRename={() => undefined}
      onCancelRename={() => undefined}
    />,
  );
};

it("a seat row says Not started only while the seat is waiting for its first assignment", () => {
  expect(seatRow({ notStarted: true })).toContain("Not started");
});

it("a seat whose first start failed says how it ended, not Not started", () => {
  const failed = seatRow({ notStarted: true, runtimeStatus: "failed" });
  expect(failed).toContain("Failed");
  expect(failed).not.toContain("Not started");
  const interrupted = seatRow({ notStarted: true, runtimeStatus: "interrupted" });
  expect(interrupted).toContain("Interrupted");
  expect(interrupted).not.toContain("Not started");
});
