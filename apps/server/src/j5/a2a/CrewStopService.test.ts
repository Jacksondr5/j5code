import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import { CrewStopService, layer as crewStopLayer } from "./CrewStopService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-stop");
const captainThread = ThreadId.make("thread:captain");
const builderThread = ThreadId.make("thread:builder");
const criticThread = ThreadId.make("thread:critic");
const retiredThread = ThreadId.make("thread:retired");
const createdAt = DateTime.makeUnsafe("2026-09-14T20:00:00.000Z");

const projection = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:crew-stop"),
      archivedAt: threadId === retiredThread ? "2026-09-14T19:00:00.000Z" : null,
    },
    runs: [],
  }) as unknown as OrchestrationV2ThreadProjection;

it.effect("interrupts only running seats, for the Captain or a person, and nobody else", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(ledgerLayer, crewInstanceLayer).pipe(
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
      ),
    );
    yield* runJ5A2AMigrations().pipe(Effect.provide(context));
    yield* Context.get(context, A2ALedger).createSquadron({
      squadron: { id: squadronId, name: "Stop", createdAt: DateTime.formatIso(createdAt) },
    });
    const captain = participantIdForThread(captainThread);
    yield* Context.get(context, AgentCrewInstanceService).record({
      id: "crew:stop",
      squadronId,
      captainParticipantId: captain,
      captainThreadId: captainThread,
      displayName: "Stop Crew",
      brief: "Work.",
      createdAt: DateTime.formatIso(createdAt),
      members: [
        {
          seatName: "builder",
          agentId: "builder",
          participantId: participantIdForThread(builderThread),
          threadId: builderThread,
          reason: null,
        },
        {
          seatName: "critic",
          agentId: "critic",
          participantId: participantIdForThread(criticThread),
          threadId: criticThread,
          reason: null,
        },
        {
          seatName: "retired",
          agentId: "scout",
          participantId: participantIdForThread(retiredThread),
          threadId: retiredThread,
          reason: null,
        },
      ],
    });
    const interrupts = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = crewStopLayer.pipe(
      Layer.provideMerge(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
          // Only the builder has a turn to interrupt.
          interruptThread: (input) =>
            Ref.update(interrupts, (items) => [
              ...items,
              `${input.threadId}:${input.commandId}`,
            ]).pipe(
              Effect.as(
                input.threadId === builderThread
                  ? ({ type: "interrupt_requested" } as never)
                  : ({ type: "already_idle" } as never),
              ),
            ),
        }),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
    );
    yield* Effect.gen(function* () {
      const service = yield* CrewStopService;
      const commandIds = (seatName: string) => ({
        interruptCommandId: CommandId.make(`stop:${seatName}`),
      });

      const stopped = yield* service.stop({
        callerParticipantId: captain,
        squadronId,
        crewInstanceId: "crew:stop",
        commandIds,
      });
      assert.deepStrictEqual(
        stopped.members.map(({ seatName, result }) => [seatName, result]),
        [
          ["builder", "interrupt_requested"],
          ["critic", "already_idle"],
          ["retired", "archived"],
        ],
      );
      // The archived seat is never interrupted; live seats use the caller's deterministic ids.
      assert.deepStrictEqual(yield* Ref.get(interrupts), [
        `${builderThread}:stop:builder`,
        `${criticThread}:stop:critic`,
      ]);

      // A person stops the same Crew without a participant id.
      const byHuman = yield* service.stop({
        callerParticipantId: null,
        squadronId: null,
        crewInstanceId: "crew:stop",
        commandIds,
      });
      assert.lengthOf(byHuman.members, 3);

      // A member, or any other agent, is refused and pointed at the Captain.
      const refused = yield* service
        .stop({
          callerParticipantId: participantIdForThread(builderThread),
          squadronId,
          crewInstanceId: "crew:stop",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewStopRequestError");
      assert.include(refused.message, "only its Captain or the human");
      const wrongSquadron = yield* service
        .stop({
          callerParticipantId: captain,
          squadronId: SquadronId.make("squadron:other"),
          crewInstanceId: "crew:stop",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.include(wrongSquadron.message, "lives in Squadron");
      const missing = yield* service
        .stop({
          callerParticipantId: null,
          squadronId: null,
          crewInstanceId: "crew:nope",
          commandIds,
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "CrewStopNotFoundError");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
