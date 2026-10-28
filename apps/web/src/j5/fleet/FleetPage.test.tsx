import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { FleetRowItem } from "./FleetPage";
import type { FleetAgent, ScopedFleetLedgerProject } from "./fleetClient";

const environmentId = EnvironmentId.make("environment:local");
const threadId = ThreadId.make("thread:builder");
const project = {
  id: "project:1",
  title: "Project",
  agents: [],
  crews: [],
  environmentId,
  environmentLabel: "Local",
} as ScopedFleetLedgerProject;

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
  const agent: FleetAgent = {
    participantId: "agent:j5:a2a:thread:builder",
    threadId,
    displayName: "builder",
    origin: "agent",
    placementParentId: null,
    crew: {
      crewInstanceId: "crew:1",
      crewName: "Review Pair",
      seat: "builder",
      notStarted: input.notStarted,
      captainParticipantId: "agent:j5:a2a:thread:captain",
    },
    openAsks: 0,
  };
  return renderToStaticMarkup(
    <ul>
      <FleetRowItem
        showEnvironment={false}
        threadsByKey={new Map([[scopedThreadKey(scopeThreadRef(environmentId, threadId)), thread]])}
        onOpenThread={() => undefined}
        projectOf={() => undefined}
        project={project}
        row={{ agent, depth: 1, crewInstanceId: "crew:1" }}
        badge={null}
      />
    </ul>,
  );
};

it("a Fleet seat row says Not started only while the seat is waiting for its first assignment", () => {
  expect(seatRow({ notStarted: true })).toContain("Not started");
});

it("a Fleet seat whose first start failed says how it ended, not Not started", () => {
  const failed = seatRow({ notStarted: true, runtimeStatus: "failed" });
  expect(failed).toContain("Failed");
  expect(failed).not.toContain("Not started");
  const interrupted = seatRow({ notStarted: true, runtimeStatus: "interrupted" });
  expect(interrupted).toContain("Interrupted");
  expect(interrupted).not.toContain("Not started");
});
