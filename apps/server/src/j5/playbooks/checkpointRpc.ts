import type { ThreadId } from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS, type PlaybookCheckpointAnswer } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import { isOwner, requireWrites } from "../sharing/connectionWriter.ts";
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
  const authorized = <A, E, R extends PersonAccess | SharedThreads>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.provideService(PersonAccess, people),
      Effect.provideService(SharedThreads, shared),
    );
  return {
    [J5_PLAYBOOK_WS_METHODS.listCheckpoints]: Effect.fn("PlaybookCheckpointRpc.list")(
      function* (input: { threadId?: ThreadId }) {
        return {
          requests: yield* store.pendingCheckpoints(
            yield* people.sessionReach(session),
            input.threadId,
          ),
        };
      },
      Effect.mapError(storageError),
    ),
    [J5_PLAYBOOK_WS_METHODS.countCheckpoints]: Effect.fn("PlaybookCheckpointRpc.count")(
      function* () {
        return yield* store.countCheckpoints(yield* people.sessionReach(session));
      },
      Effect.mapError(storageError),
    ),
    [J5_PLAYBOOK_WS_METHODS.answerCheckpoint]: Effect.fn("PlaybookCheckpointRpc.answer")(function* (
      input: PlaybookCheckpointAnswer,
    ) {
      yield* authorized(requireWrites(session, Effect.succeed(input.threadId)));
      return yield* store.answerCheckpoint(input, yield* authorized(isOwner(session)));
    }, Effect.mapError(storageError)),
  };
});
