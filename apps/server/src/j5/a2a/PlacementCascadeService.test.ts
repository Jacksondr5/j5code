import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ParticipantPlacementView } from "./placementContracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";
import { makePlacementCascadeService } from "./PlacementCascadeService.ts";
import { EpicId, ParticipantId } from "./contracts.ts";

const epicId = EpicId.make("epic:cascade-dispatch");
const projectId = ProjectId.make("project:cascade-dispatch");
const rootId = ParticipantId.make("agent:root");
const branchId = ParticipantId.make("agent:branch");
const leafId = ParticipantId.make("agent:leaf");
const rootThreadId = ThreadId.make("thread:root");
const branchThreadId = ThreadId.make("thread:branch");
const leafThreadId = ThreadId.make("thread:leaf");
class CascadeTestFailure extends Data.TaggedError("CascadeTestFailure")<{
  readonly operation: string;
}> {}

const participant = (
  participantId: ParticipantId,
  threadId: ThreadId,
  placementParentId: ParticipantId | null,
): ParticipantPlacementView => ({
  epicId,
  participant: { kind: "agent", id: participantId, threadId },
  participantId,
  threadId,
  provenance: { kind: "unknown", source: "native_or_unobserved" },
  placementParentId,
});

const leavesFirst = [
  participant(leafId, leafThreadId, branchId),
  participant(branchId, branchThreadId, rootId),
  participant(rootId, rootThreadId, null),
] as const;

const makeHarness = (options: {
  readonly archived?: ReadonlySet<ThreadId>;
  readonly interruptFailureThread?: ThreadId;
}) => {
  const projectionReads: Array<ThreadId> = [];
  const interruptCalls: Array<{
    projectId: ProjectId;
    commandId: string;
    threadId: ThreadId;
    reason: string | undefined;
  }> = [];
  const archiveCalls: Array<{ commandId: string; threadId: ThreadId }> = [];
  const service = makePlacementCascadeService({
    placement: {
      listSubtree: () => Effect.succeed(leavesFirst),
    },
    threads: {
      getThreadProjection: (threadId) => {
        projectionReads.push(threadId);
        return Effect.succeed({
          thread: {
            projectId,
            archivedAt: options.archived?.has(threadId) === true ? "2026-08-16T00:00:00Z" : null,
          },
        } as OrchestrationV2ThreadProjection);
      },
      interruptThread: (input) => {
        interruptCalls.push({
          projectId: input.projectId,
          commandId: input.commandId,
          threadId: input.threadId,
          reason: input.reason,
        });
        return input.threadId === options.interruptFailureThread
          ? Effect.fail(new CascadeTestFailure({ operation: "interrupt dispatch" }))
          : Effect.succeed({ type: "no_active_run" } as const);
      },
    },
    lifecycle: {
      archive: (input) => {
        archiveCalls.push({ commandId: input.commandId, threadId: input.threadId });
        return Effect.succeed({});
      },
    },
  });
  return { service, projectionReads, interruptCalls, archiveCalls };
};

it.effect("dispatches stop and archive leaves-first with stable per-thread command ids", () =>
  Effect.gen(function* () {
    const stop = makeHarness({});
    const stopResult = yield* stop.service.stop({
      commandId: PlacementCommandId.make("cascade:one"),
      epicId,
      participantId: rootId,
    });
    assert.deepStrictEqual(
      stop.interruptCalls,
      [leafThreadId, branchThreadId, rootThreadId].map((threadId) => ({
        projectId,
        commandId: `cascade:one:stop:${threadId}`,
        threadId,
        reason: `Placement cascade requested by ${rootId}.`,
      })),
    );
    assert.deepStrictEqual(
      stopResult.map((row) => row.outcome),
      ["no_active_run", "no_active_run", "no_active_run"],
    );

    const archive = makeHarness({ archived: new Set([branchThreadId]) });
    const archiveResult = yield* archive.service.archive({
      commandId: PlacementCommandId.make("cascade:two"),
      epicId,
      participantId: rootId,
    });
    assert.deepStrictEqual(archive.projectionReads, [leafThreadId, branchThreadId, rootThreadId]);
    assert.deepStrictEqual(
      archive.archiveCalls,
      [leafThreadId, rootThreadId].map((threadId) => ({
        commandId: `cascade:two:archive:${threadId}`,
        threadId,
      })),
    );
    assert.deepStrictEqual(
      archiveResult.map((row) => row.outcome),
      ["archived", "already_archived", "archived"],
    );
  }),
);

it.effect("stops after a mid-cascade failure while preserving earlier descendant dispatches", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ interruptFailureThread: branchThreadId });
    const error = yield* Effect.flip(
      harness.service.stop({
        commandId: PlacementCommandId.make("cascade:partial"),
        epicId,
        participantId: rootId,
      }),
    );

    assert.equal(error._tag, "PlacementCascadeDispatchError");
    if (error._tag !== "PlacementCascadeDispatchError") return;
    assert.equal(error.participantId, branchId);
    assert.deepStrictEqual(
      harness.interruptCalls,
      [leafThreadId, branchThreadId].map((threadId) => ({
        projectId,
        commandId: `cascade:partial:stop:${threadId}`,
        threadId,
        reason: `Placement cascade requested by ${rootId}.`,
      })),
    );
  }),
);
