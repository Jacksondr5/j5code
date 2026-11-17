import { J5_PLAYBOOK_WS_METHODS, type PlaybookCheckpointAnswer } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { connectionReads, requireWrites } from "../sharing/connectionWriter.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";
import { PersonAccess } from "../sharing/PersonAccess.ts";
import type { SessionIdentity } from "../sharing/PersonAccess.ts";
import { PlaybookStore } from "./PlaybookStore.ts";
import { storageError } from "./definition.ts";

export const makeCheckpointRpcHandlers = Effect.fn("makeCheckpointRpcHandlers")(function* (
  session: SessionIdentity,
) {
  const store = yield* PlaybookStore;
  const people = yield* PersonAccess;
  const shared = yield* SharedThreads;
  const authorized = <A, E>(effect: Effect.Effect<A, E, PersonAccess | SharedThreads>) =>
    effect.pipe(
      Effect.provideService(PersonAccess, people),
      Effect.provideService(SharedThreads, shared),
    );
  return {
    [J5_PLAYBOOK_WS_METHODS.listCheckpoints]: Effect.fn("PlaybookCheckpointRpc.list")(function* () {
      const reaches = yield* authorized(connectionReads(session));
      return {
        requests: yield* Effect.filter(yield* store.pendingCheckpoints(), (request) =>
          authorized(reaches(Effect.succeed(request.ownerThreadId))),
        ),
      };
    }, Effect.mapError(storageError)),
    [J5_PLAYBOOK_WS_METHODS.answerCheckpoint]: Effect.fn("PlaybookCheckpointRpc.answer")(function* (
      input: PlaybookCheckpointAnswer,
    ) {
      yield* authorized(requireWrites(session, Effect.succeed(input.threadId)));
      return yield* store.answerCheckpoint(input);
    }, Effect.mapError(storageError)),
  };
});
