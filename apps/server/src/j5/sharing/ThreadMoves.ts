/**
 * Upstream's Turn into project moves a thread to another project and writes no one's level, so
 * nothing in `PersonAccess` would say that what the old and new projects' people reach changed.
 * This daemon says it for them, and every narrowed feed re-checks as it does after a grant.
 *
 * @module ThreadMoves
 */
import type { CommandId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { readEventStoreHighWater } from "../a2a/eventStoreHighWater.ts";
import { PersonAccess, layer as personAccessLayer } from "./PersonAccess.ts";

/** The one command that changes a thread's project. Its event does not say which it left. */
const MOVE_COMMAND = "thread.project.adopt-folder";

const make = Effect.gen(function* () {
  const events = yield* EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const access = yield* PersonAccess;

  // The receipt commits with the event, so it is there by the time the event is streamed.
  const isMove = (commandId: CommandId | null) =>
    commandId === null
      ? Effect.succeed(false)
      : sql<{ readonly found: number }>`
          SELECT 1 AS found FROM orchestration_command_receipts
          WHERE command_id = ${commandId} AND command_type = ${MOVE_COMMAND}
        `.pipe(Effect.map((rows) => rows.length > 0));

  const highWater = readEventStoreHighWater("J5 thread move announcer").pipe(
    Effect.provideService(EventSinkV2, events),
  );
  const followFrom = (afterSequence: number) =>
    events.stream({ afterSequence, eventType: "thread.metadata-updated" }).pipe(
      Stream.filterEffect((stored) => isMove(stored.commandId)),
      Stream.runForEach(() => access.announcePartialReach),
    );
  // A move the broken stream did not deliver is at or below the new mark and is not replayed.
  const resumed = Effect.fn("j5.sharing.threadMoves.resumed")(function* () {
    const afterSequence = yield* highWater;
    yield* access.announcePartialReach;
    yield* followFrom(afterSequence);
  });
  const run = <E>(follow: Effect.Effect<void, E>): Effect.Effect<never> =>
    follow.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 thread move announcer lost the event stream; resuming", {
          cause,
        }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
      ),
      Effect.andThen(Effect.suspend(() => run(resumed()))),
    );
  // Only moves from here on: a feed opened later reads reach when it opens. The mark is read
  // before the layer is up, so a move made once it is up is always followed. The read retries
  // until it succeeds.
  const afterSequence = yield* Effect.orDie(highWater);
  yield* run(followFrom(afterSequence)).pipe(Effect.forkScoped);
});

/** Over the server's one `PersonAccess` (the same layer object, so the same instance). */
export const layer: Layer.Layer<never, never, EventSinkV2 | SqlClient.SqlClient> =
  Layer.effectDiscard(make).pipe(Layer.provide(personAccessLayer));
