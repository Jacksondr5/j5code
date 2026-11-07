import { type ThreadId } from "@t3tools/contracts";
import type {
  PersonalThreadMarkUnread,
  PersonalThreadRead,
  PersonalThreadReadChange,
  PersonalThreadVisit,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { requestDigest } from "../a2a/RequestReplayService.ts";
import {
  PersonAccess,
  type SessionIdentity,
  isWide,
  layer as personAccessLayer,
} from "./PersonAccess.ts";

export class ThreadReadStateError extends Schema.TaggedError<ThreadReadStateError>()(
  "ThreadReadStateError",
  {
    reason: Schema.Literals([
      "not-person",
      "not-shared",
      "no-completion",
      "request-conflict",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-person":
        return "This device is not paired as a person on this server.";
      case "not-shared":
        return "This thread is not shared with you on this server.";
      case "no-completion":
        return "This thread has no completed run to mark unread.";
      case "request-conflict":
        return "This command id already belongs to a different read-state change.";
      case "storage":
        return "Could not read or save your thread read state.";
    }
  }
}

const isThreadReadStateError = Schema.is(ThreadReadStateError);
const readFailure = (cause: unknown) =>
  isThreadReadStateError(cause) ? cause : new ThreadReadStateError({ reason: "storage", cause });

export class ThreadReadState extends Context.Service<
  ThreadReadState,
  {
    readonly visit: (
      session: SessionIdentity,
      input: PersonalThreadVisit,
    ) => Effect.Effect<PersonalThreadRead, ThreadReadStateError>;
    readonly markUnread: (
      session: SessionIdentity,
      input: PersonalThreadMarkUnread,
    ) => Effect.Effect<PersonalThreadRead, ThreadReadStateError>;
    readonly subscribe: (
      session: SessionIdentity,
    ) => Stream.Stream<PersonalThreadReadChange, ThreadReadStateError>;
  }
>()("t3/j5/sharing/ThreadReadState") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* PersonAccess;
  const threads = yield* ThreadManagementService;
  const changes = yield* PubSub.unbounded<{
    readonly personId: string;
    readonly threadId: ThreadId;
  }>();

  const person = Effect.fn("ThreadReadState.person")(function* (session: SessionIdentity) {
    const reach = yield* access.sessionReach(session);
    if (reach.kind !== "person") return yield* new ThreadReadStateError({ reason: "not-person" });
    return reach;
  });

  const change = Effect.fn("ThreadReadState.change")(function* (
    session: SessionIdentity,
    input: PersonalThreadVisit | PersonalThreadMarkUnread,
  ) {
    const reach = yield* person(session);
    const personId = reach.person.personId;
    if (!isWide(reach) && (yield* access.threadLevel(personId, input.threadId)) === null) {
      return yield* new ThreadReadStateError({ reason: "not-shared" });
    }
    const shell = yield* threads.getThreadShell(input.threadId);
    if (shell === null || shell.deletedAt !== null)
      return yield* new ThreadReadStateError({ reason: "not-shared" });
    const digest = requestDigest(input);
    const replay = Effect.fn("ThreadReadState.replay")(function* () {
      const rows = yield* sql<{
        readonly request_digest: string;
        readonly last_visited_at: string;
      }>`
        SELECT request_digest, last_visited_at FROM j5_thread_read_command
        WHERE person_id = ${personId} AND command_id = ${input.commandId}
      `;
      const row = rows[0];
      if (row !== undefined && row.request_digest !== digest) {
        return yield* new ThreadReadStateError({ reason: "request-conflict" });
      }
      return row;
    });
    const original = yield* replay();
    if (original !== undefined)
      return {
        threadId: input.threadId,
        lastVisitedAt: DateTime.makeUnsafe(original.last_visited_at),
      };

    const visit = "visitedAt" in input;
    if (!visit && shell.latestRunCompletedAt == null)
      return yield* new ThreadReadStateError({ reason: "no-completion" });
    const requested = visit
      ? DateTime.makeUnsafe(input.visitedAt)
      : DateTime.subtract(shell.latestRunCompletedAt!, { milliseconds: 1 });
    // Keep upstream's search ranking for wide connections without moving its shared read marker.
    if (visit && input.opened && isWide(reach)) {
      yield* threads.dispatch({
        type: "thread.visit",
        commandId: input.commandId,
        threadId: input.threadId,
        visitedAt: DateTime.formatIso(shell.lastVisitedAt ?? DateTime.makeUnsafe(0)),
        opened: true,
        ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
      });
    }
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const marker = yield* sql.withTransaction(
          Effect.gen(function* () {
            const repeated = yield* replay();
            if (repeated !== undefined)
              return {
                threadId: input.threadId,
                lastVisitedAt: DateTime.makeUnsafe(repeated.last_visited_at),
              };
            const at = DateTime.formatIso(requested);
            if (visit) {
              yield* sql`
          INSERT INTO j5_thread_read (person_id, thread_id, last_visited_at)
          VALUES (${personId}, ${input.threadId}, ${at})
          ON CONFLICT(person_id, thread_id) DO UPDATE SET
            last_visited_at = MAX(j5_thread_read.last_visited_at, excluded.last_visited_at)
        `;
            } else {
              yield* sql`
          INSERT INTO j5_thread_read (person_id, thread_id, last_visited_at)
          VALUES (${personId}, ${input.threadId}, ${at})
          ON CONFLICT(person_id, thread_id) DO UPDATE SET last_visited_at = excluded.last_visited_at
        `;
            }
            const [saved] = yield* sql<{ readonly last_visited_at: string }>`
        SELECT last_visited_at FROM j5_thread_read WHERE person_id = ${personId} AND thread_id = ${input.threadId}
      `;
            yield* sql`
        INSERT INTO j5_thread_read_command (person_id, command_id, request_digest, thread_id, last_visited_at)
        VALUES (${personId}, ${input.commandId}, ${digest}, ${input.threadId}, ${saved!.last_visited_at})
      `;
            return {
              threadId: input.threadId,
              lastVisitedAt: DateTime.makeUnsafe(saved!.last_visited_at),
            };
          }),
        );
        yield* PubSub.publish(changes, { personId, threadId: input.threadId });
        return marker;
      }),
    );
  }, Effect.mapError(readFailure));

  const subscribe = (session: SessionIdentity) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const reach = yield* person(session);
        const personId = reach.person.personId;
        const changed = yield* PubSub.subscribe(changes);
        const accessChanged = yield* access.subscribeChanges;
        const snapshot = Effect.fn("ThreadReadState.snapshot")(function* () {
          const reachable = yield* access.reachableThreads(personId);
          const visible = reachable === null ? null : new Set(reachable);
          const rows = yield* sql<{
            readonly thread_id: ThreadId;
            readonly last_visited_at: string;
          }>`
        SELECT read.thread_id, read.last_visited_at FROM j5_thread_read AS read
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = read.thread_id
        WHERE read.person_id = ${personId} AND thread.deleted_at IS NULL
      `;
          return {
            kind: "snapshot" as const,
            markers: rows.flatMap((row) =>
              visible !== null && !visible.has(row.thread_id)
                ? []
                : [
                    {
                      threadId: row.thread_id,
                      lastVisitedAt: DateTime.makeUnsafe(row.last_visited_at),
                    },
                  ],
            ),
          };
        });
        const updates = Stream.fromSubscription(changed).pipe(
          Stream.filter((event) => event.personId === personId),
          Stream.mapEffect(
            Effect.fn("ThreadReadState.changed")(function* (event) {
              if ((yield* access.threadLevel(personId, event.threadId)) === null) return [];
              const rows = yield* sql<{ readonly last_visited_at: string }>`
          SELECT read.last_visited_at FROM j5_thread_read AS read
          JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = read.thread_id
          WHERE read.person_id = ${personId} AND read.thread_id = ${event.threadId} AND thread.deleted_at IS NULL
        `;
              return rows.map((row) => ({
                kind: "changed" as const,
                marker: {
                  threadId: event.threadId,
                  lastVisitedAt: DateTime.makeUnsafe(row.last_visited_at),
                },
              }));
            }),
          ),
          Stream.flatMap(Stream.fromIterable),
        );
        return Stream.concat(
          Stream.fromEffect(snapshot()),
          Stream.merge(
            updates,
            Stream.fromSubscription(accessChanged).pipe(
              Stream.filter((id) => id === personId),
              Stream.mapEffect(() => snapshot()),
            ),
          ),
        );
      }),
    ).pipe(Stream.mapError(readFailure));

  return ThreadReadState.of({
    visit: change,
    markUnread: change,
    subscribe,
  });
});

export const layer = Layer.effect(ThreadReadState, make).pipe(Layer.provide(personAccessLayer));
