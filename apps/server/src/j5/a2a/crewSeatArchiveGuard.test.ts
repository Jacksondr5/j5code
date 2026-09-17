import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { makeCrewSeatArchiveGuard } from "./crewSeatArchiveGuard.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const seatThread = ThreadId.make("thread:seat");
const retiredSeatThread = ThreadId.make("thread:retired-seat");
const plainThread = ThreadId.make("thread:plain");
const instance = (id: string, archivedAt: string | null): AgentCrewInstance => ({
  id,
  squadronId: SquadronId.make("squadron:guard"),
  captainParticipantId: ParticipantId.make("agent:j5:a2a:thread:captain"),
  captainThreadId: ThreadId.make("thread:captain"),
  displayName: "Review Pair",
  brief: "Review it.",
  version: 1,
  createdAt: "2026-09-17T09:00:00.000Z",
  archivedAt,
  members: [],
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
      const guard = yield* makeCrewSeatArchiveGuard.pipe(Effect.provide(crews));
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
    const guard = yield* makeCrewSeatArchiveGuard.pipe(Effect.provide(crews));
    yield* guard(command("thread.archive", seatThread));
  }),
);
