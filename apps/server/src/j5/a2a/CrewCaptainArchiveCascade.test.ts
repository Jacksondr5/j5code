import {
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService, type ArchiveCrewInput } from "./ArchiveCrewService.ts";
import { CrewCaptainArchiveCascade, layer as cascadeLayer } from "./CrewCaptainArchiveCascade.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:j5:cascade");
const captainThread = ThreadId.make("thread:captain");
const seatThread = ThreadId.make("thread:seat");
const crew = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  squadronId,
  captainParticipantId: participantIdForThread(captainThread),
  captainThreadId: captainThread,
  displayName: id,
  brief: "Land it.",
  version: 1,
  createdAt: "2026-09-15T10:00:00.000Z",
  archivedAt,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: ParticipantId.make("agent:j5:a2a:thread:seat"),
      threadId: seatThread,
      addedVersion: 1,
      reason: null,
    },
  ],
});
const archivedEvent = (threadId: ThreadId, type = "thread.archived"): OrchestrationV2StoredEvent =>
  ({ sequence: 1, commandId: null, event: { type, threadId } }) as never;
const captainProjection = (archivedAt: string | null, deletedAt: string | null = null) =>
  ({
    thread: { id: captainThread, archivedAt, deletedAt },
  }) as unknown as OrchestrationV2ThreadProjection;
const noThreads = Layer.mock(ThreadManagementService)({});

it.effect("retires the live Crews a Captain commanded when the person archives its thread", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: (input) =>
              Effect.succeed(
                input.threadIds.includes(captainThread)
                  ? [crew("crew:live", null), crew("crew:old", "2026-09-14T00:00:00.000Z")]
                  : [],
              ),
          }),
          Layer.mock(ArchiveCrewService)({
            archive: (input) =>
              Ref.update(calls, (items) => [...items, input]).pipe(
                Effect.as({ status: "archived" as const, members: [] }),
              ),
          }),
          noThreads,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      // A seat's own archive commands nothing; unrelated events are ignored.
      assert.isNull(yield* cascade.handleStoredEvent(archivedEvent(seatThread)));
      assert.isNull(yield* cascade.handleStoredEvent(archivedEvent(captainThread, "run.updated")));
      assert.deepStrictEqual(yield* cascade.handleStoredEvent(archivedEvent(captainThread)), [
        "crew:live",
      ]);
      const [call] = yield* Ref.get(calls);
      assert.isNull(call?.callerParticipantId);
      assert.isTrue(call?.confirmationSatisfied);
      assert.equal(call?.crewInstanceId, "crew:live");
      // Same Captain, same Crew, same command ids: a replayed event converges.
      const again = yield* cascade.handleStoredEvent(
        archivedEvent(captainThread, "thread.deleted"),
      );
      assert.deepStrictEqual(again, ["crew:live"]);
      const [first, second] = yield* Ref.get(calls);
      assert.equal(
        first?.commandIds("builder").archiveCommandId,
        second?.commandIds("builder").archiveCommandId,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "the boot sweep retires live Crews whose Captain is archived or gone, and no others",
  () =>
    Effect.gen(function* () {
      const goneCaptain = ThreadId.make("thread:gone-captain");
      const liveCaptain = ThreadId.make("thread:live-captain");
      const unreadable = ThreadId.make("thread:unreadable-captain");
      const commanded = (id: string, captain: ThreadId): AgentCrewInstance => ({
        ...crew(id, null),
        captainThreadId: captain,
        captainParticipantId: participantIdForThread(captain),
      });
      const calls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
      const layer = cascadeLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentCrewInstanceService)({
              listLive: () =>
                Effect.succeed([
                  crew("crew:archived-captain", null),
                  commanded("crew:gone-captain", goneCaptain),
                  commanded("crew:live-captain", liveCaptain),
                  commanded("crew:unreadable", unreadable),
                ]),
            }),
            Layer.mock(ArchiveCrewService)({
              archive: (input) =>
                Ref.update(calls, (items) => [...items, input]).pipe(
                  Effect.as({ status: "archived" as const, members: [] }),
                ),
            }),
            Layer.mock(ThreadManagementService)({
              getThreadProjection: (threadId) =>
                threadId === captainThread
                  ? Effect.succeed(captainProjection("2026-09-17T08:00:00.000Z"))
                  : threadId === liveCaptain
                    ? Effect.succeed(captainProjection(null))
                    : threadId === goneCaptain
                      ? Effect.succeed(captainProjection(null, "2026-09-17T08:30:00.000Z"))
                      : Effect.die(new Error("projection store unavailable")),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cascade = yield* CrewCaptainArchiveCascade;
        const retired = yield* cascade.reconcile;
        assert.deepStrictEqual(retired, ["crew:archived-captain", "crew:gone-captain"]);
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((call) => call.crewInstanceId),
          ["crew:archived-captain", "crew:gone-captain"],
        );
      }).pipe(Effect.provide(layer));
    }),
);
