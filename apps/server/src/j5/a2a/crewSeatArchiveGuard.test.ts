import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { makeCrewSeatArchiveGuard } from "./crewSeatArchiveGuard.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, LedgerProjectId } from "./contracts.ts";

const seatThread = ThreadId.make("thread:seat");
const retiredSeatThread = ThreadId.make("thread:retired-seat");
const plainThread = ThreadId.make("thread:plain");
const instance = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  projectId: LedgerProjectId.make("project:guard"),
  captainParticipantId: ParticipantId.make("agent:j5:a2a:thread:captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  displayName: "Review Pair",
  brief: "Review it.",
  version: 1,
  createdAt: "2026-09-17T09:00:00.000Z",
  archivedAt,
  members: [],
});
/** Threads whose delegated tasks are still running. */
const threadsDelegating = (delegating: ReadonlyArray<ThreadId>) =>
  Layer.mock(ThreadManagementService)({
    getThreadRecords: (threadId) =>
      Effect.succeed({
        subagents: delegating.includes(threadId)
          ? [
              {
                origin: "app_owned",
                childThreadId: ThreadId.make("thread:child"),
                status: "running",
              },
            ]
          : [],
      } as never),
  });

const command = (type: "thread.archive" | "thread.delete" | "thread.pin", threadId: ThreadId) =>
  ({
    type,
    commandId: CommandId.make(`cmd:${type}:${threadId}`),
    threadId,
  }) as OrchestrationV2Command;

it.effect(
  "refuses to archive or delete a live Crew's seat alone and lets every other thread through",
  () =>
    Effect.gen(function* () {
      const crews = Layer.mock(AgentCrewInstanceService)({
        listInvolving: () => Effect.succeed([]),
        findMembership: (participantId) =>
          Effect.succeed(
            participantId === participantIdForThread(seatThread)
              ? { crewInstanceId: "crew:live", seatName: "critic" }
              : participantId === participantIdForThread(retiredSeatThread)
                ? { crewInstanceId: "crew:old", seatName: "critic" }
                : null,
          ),
        read: (id) =>
          Effect.succeed(
            id === "crew:live"
              ? instance(id, null)
              : id === "crew:old"
                ? instance(id, "2026-09-17T10:00:00.000Z")
                : null,
          ),
      });
      const guard = yield* makeCrewSeatArchiveGuard.pipe(
        Effect.provide(Layer.merge(crews, threadsDelegating([]))),
      );
      const refused = yield* guard(command("thread.archive", seatThread)).pipe(Effect.flip);
      assert.equal(refused._tag, "CrewSeatArchivedAloneError");
      assert.include(refused.message, "seat critic of Crew Review Pair");
      assert.include(refused.message, "never archived one by one");
      const deleted = yield* guard(command("thread.delete", seatThread)).pipe(Effect.flip);
      assert.include(deleted.message, "never deleted one by one");
      // A retired Crew's seat is a plain agent again; other commands are not the guard's business.
      yield* guard(command("thread.archive", retiredSeatThread));
      yield* guard(command("thread.archive", plainThread));
      yield* guard(command("thread.pin", seatThread));
    }),
);

it.effect("lets the archive through when the Crew store cannot be read", () =>
  Effect.gen(function* () {
    const crews = Layer.mock(AgentCrewInstanceService)({
      findMembership: () => Effect.die(new Error("database locked")),
    });
    const guard = yield* makeCrewSeatArchiveGuard.pipe(
      Effect.provide(Layer.merge(crews, threadsDelegating([]))),
    );
    yield* guard(command("thread.archive", seatThread));
  }),
);

it.effect("refuses a Captain's archive while a seat of its Crew runs delegated tasks", () =>
  Effect.gen(function* () {
    const captain = ThreadId.make("thread:captain");
    const crew = {
      ...instance("crew:live", null),
      members: [
        {
          seatName: "builder",
          agentId: null,
          participantId: participantIdForThread(seatThread),
          threadId: seatThread,
          addedVersion: 1,
          reason: null,
        },
      ],
    } as AgentCrewInstance;
    const crews = Layer.mock(AgentCrewInstanceService)({
      findMembership: () => Effect.succeed(null),
      listInvolving: () => Effect.succeed([crew]),
    });
    const guardWith = (delegating: ReadonlyArray<ThreadId>) =>
      makeCrewSeatArchiveGuard.pipe(
        Effect.provide(Layer.merge(crews, threadsDelegating(delegating))),
      );

    const refused = yield* (yield* guardWith([seatThread]))(
      command("thread.archive", captain),
    ).pipe(Effect.flip);
    assert.equal(refused._tag, "CaptainCrewDelegatingError");
    assert.include(refused.message, "seat(s) builder");
    assert.include(refused.message, "Nothing was archived");
    // Nothing delegating: the Captain archives, and its Crew retires after it.
    yield* (yield* guardWith([]))(command("thread.archive", captain));
  }),
);
