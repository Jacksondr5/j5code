import {
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
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
      // Recorded as retired with its Captain, so the Captain's unarchive brings it back.
      assert.isTrue(call?.withCaptain);
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
              listRetiredWithCaptain: () => Effect.succeed([]),
            }),
            Layer.mock(ArchiveCrewService)({
              // The first orphaned Crew will not retire; the sweep must still reach the second.
              archive: (input) =>
                Ref.update(calls, (items) => [...items, input]).pipe(
                  Effect.flatMap(() =>
                    input.crewInstanceId === "crew:archived-captain"
                      ? Effect.die(new Error("a seat refused to archive"))
                      : Effect.succeed({ status: "archived" as const, members: [] }),
                  ),
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
        // Both orphaned Crews were attempted; the one whose archive failed is left for the next
        // boot rather than aborting the sweep before the second.
        assert.deepStrictEqual(retired, ["crew:gone-captain"]);
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((call) => call.crewInstanceId),
          [
            "crew:archived-captain",
            "crew:archived-captain",
            "crew:archived-captain",
            "crew:gone-captain",
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("retries a transient event cascade in-session with the same commands", () =>
  Effect.gen(function* () {
    const calls: Array<ArchiveCrewInput> = [];
    const testLayer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: () => Effect.succeed([crew("retry", null)]),
          }),
          Layer.mock(ArchiveCrewService)({
            archive: (input) =>
              Effect.suspend(() => {
                calls.push(input);
                return calls.length === 1
                  ? Effect.die("transient archive failure")
                  : Effect.succeed({ status: "archived" as const, members: [] });
              }),
          }),
          noThreads,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.deepStrictEqual(yield* cascade.handleStoredEvent(archivedEvent(captainThread)), [
        "retry",
      ]);
      assert.lengthOf(calls, 2);
      assert.deepStrictEqual(calls[0]!.commandIds("builder"), calls[1]!.commandIds("builder"));
    }).pipe(Effect.provide(testLayer));
  }),
);

const criticThread = ThreadId.make("thread:critic");
const pair = (id: string, archivedAt: string | null): AgentCrewInstance => {
  const base = crew(id, archivedAt);
  return {
    ...base,
    members: [
      ...base.members,
      {
        seatName: "critic",
        agentId: "critic",
        participantId: ParticipantId.make("agent:j5:a2a:thread:critic"),
        threadId: criticThread,
        addedVersion: 1,
        reason: null,
      },
    ],
  };
};
const seatProjection = (
  threadId: ThreadId,
  facts: { settledOverride?: "settled" | "active" | null; archivedAt?: string | null } = {},
) =>
  ({
    thread: {
      id: threadId,
      archivedAt: facts.archivedAt ?? null,
      deletedAt: null,
      settledOverride: facts.settledOverride ?? null,
      settledAt:
        facts.settledOverride === "settled"
          ? DateTime.makeUnsafe("2026-09-17T09:00:00.000Z")
          : null,
    },
  }) as unknown as OrchestrationV2ThreadProjection;
const lifecycleEvent = (id: string, type: string, threadId = captainThread) =>
  ({ sequence: 1, commandId: null, event: { id, type, threadId } }) as never;

it.effect("settling a Captain settles its Crew's seats, and unsettling it unsettles them", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            listInvolving: () =>
              Effect.succeed([
                pair("crew:live", null),
                pair("crew:old", "2026-09-14T00:00:00.000Z"),
              ]),
          }),
          Layer.mock(ArchiveCrewService)({}),
          Layer.mock(ThreadManagementService)({
            // The builder has not settled; the critic already has.
            getThreadProjection: (threadId) =>
              Effect.succeed(
                seatProjection(threadId, {
                  settledOverride: threadId === criticThread ? "settled" : null,
                }),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      // A seat's own settle commands nothing.
      assert.isNull(
        yield* cascade.handleStoredEvent(
          lifecycleEvent("event:seat", "thread.settled", seatThread),
        ),
      );
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled")),
        ["crew:live"],
      );
      // A replayed event converges on the same command.
      yield* cascade.handleStoredEvent(lifecycleEvent("event:settle", "thread.settled"));
      const settles = yield* Ref.get(dispatched);
      assert.deepStrictEqual(
        settles.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
        [
          ["thread.settle", seatThread],
          ["thread.settle", seatThread],
        ],
      );
      assert.equal(settles[0]?.commandId, settles[1]?.commandId);
      yield* Ref.set(dispatched, []);
      // Unsettle reaches only a seat that is settled; one that never settled keeps auto-settle.
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:unsettle", "thread.unsettled")),
        ["crew:live"],
      );
      const unsettles = yield* Ref.get(dispatched);
      assert.deepStrictEqual(
        unsettles.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
        [["thread.unsettle", criticThread]],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("unarchiving a Captain brings back the Crews that retired with it", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const restored = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = cascadeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentCrewInstanceService)({
            // The store lists only Crews that retired with this Captain, never one retired alone.
            listRetiredWithCaptain: (threadId) =>
              Effect.succeed(
                threadId === captainThread
                  ? [pair("crew:with-captain", "2026-09-17T08:00:00.000Z")]
                  : [],
              ),
            restoreWithCaptain: (id) =>
              Ref.update(restored, (items) => [...items, id]).pipe(Effect.as(true)),
            serialize: (_id, effect) => effect,
          }),
          Layer.mock(ArchiveCrewService)({}),
          Layer.mock(ThreadManagementService)({
            // The builder's thread was archived with the Crew; the critic's was never created.
            getThreadProjection: (threadId) =>
              threadId === criticThread
                ? Effect.die(new Error("not found"))
                : Effect.succeed(
                    seatProjection(threadId, { archivedAt: "2026-09-17T08:00:00.000Z" }),
                  ),
            dispatch: (command) =>
              Ref.update(dispatched, (items) => [...items, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cascade = yield* CrewCaptainArchiveCascade;
      assert.isNull(
        yield* cascade.handleStoredEvent(
          lifecycleEvent("event:other", "thread.unarchived", seatThread),
        ),
      );
      assert.deepStrictEqual(
        yield* cascade.handleStoredEvent(lifecycleEvent("event:unarchive", "thread.unarchived")),
        ["crew:with-captain"],
      );
      assert.deepStrictEqual(
        (yield* Ref.get(dispatched)).map((command) => [
          command.type,
          "threadId" in command ? command.threadId : null,
        ]),
        [["thread.unarchive", seatThread]],
      );
      assert.deepStrictEqual(yield* Ref.get(restored), ["crew:with-captain"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "the boot sweep settles a settled Captain's seats and brings back Crews under a live Captain",
  () =>
    Effect.gen(function* () {
      const settledCaptain = ThreadId.make("thread:settled-captain");
      const liveCaptain = ThreadId.make("thread:live-captain");
      const backSeat = ThreadId.make("thread:back-seat");
      const under = (id: string, captain: ThreadId, archivedAt: string | null) => ({
        ...crew(id, archivedAt),
        captainThreadId: captain,
        captainParticipantId: participantIdForThread(captain),
      });
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
      const restored = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = cascadeLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentCrewInstanceService)({
              listLive: () => Effect.succeed([under("crew:settled", settledCaptain, null)]),
              listRetiredWithCaptain: () =>
                Effect.succeed([
                  {
                    ...under("crew:back", liveCaptain, "2026-09-17T08:00:00.000Z"),
                    members: [{ ...crew("x", null).members[0]!, threadId: backSeat }],
                  },
                  under("crew:still-gone", captainThread, "2026-09-17T08:00:00.000Z"),
                ]),
              restoreWithCaptain: (id) =>
                Ref.update(restored, (items) => [...items, id]).pipe(Effect.as(true)),
              serialize: (_id, effect) => effect,
            }),
            Layer.mock(ArchiveCrewService)({}),
            Layer.mock(ThreadManagementService)({
              getThreadProjection: (threadId) =>
                Effect.succeed(
                  threadId === settledCaptain
                    ? seatProjection(threadId, { settledOverride: "settled" })
                    : threadId === captainThread
                      ? seatProjection(threadId, { archivedAt: "2026-09-17T08:00:00.000Z" })
                      : threadId === liveCaptain
                        ? seatProjection(threadId)
                        : threadId === backSeat
                          ? seatProjection(threadId, { archivedAt: "2026-09-17T08:00:00.000Z" })
                          : seatProjection(threadId),
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (items) => [...items, command]).pipe(
                  Effect.as({ sequence: 1 } as never),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cascade = yield* CrewCaptainArchiveCascade;
        assert.deepStrictEqual(yield* cascade.reconcile, ["crew:settled", "crew:back"]);
        assert.deepStrictEqual(yield* Ref.get(restored), ["crew:back"]);
        assert.deepStrictEqual(
          (yield* Ref.get(dispatched)).map((command) => [
            command.type,
            "threadId" in command ? command.threadId : null,
          ]),
          [
            ["thread.settle", seatThread],
            ["thread.unarchive", backSeat],
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
);
