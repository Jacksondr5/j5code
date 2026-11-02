import { assert, it } from "@effect/vitest";
import { AuthSessionId, CommandId, ThreadId } from "@t3tools/contracts";
import type { PersonalThreadReadChange } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { humanPersonRegistryLayer } from "../a2a/HumanPersonRegistry.ts";
import migration from "../a2a/migrations/048_PersonalThreadReads.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import * as PersonAccess from "./PersonAccess.ts";
import * as ThreadReads from "./ThreadReadState.ts";

const threadId = ThreadId.make("thread:personal-read");
const completedAt = DateTime.makeUnsafe("2026-10-31T12:00:00.000Z");
const readAt = "2026-10-31T12:01:00.000Z";
const owner = {
  sessionId: AuthSessionId.make("session:owner"),
  subject: "administrative-bootstrap",
};

function layer(completed = true) {
  const harness = makeHarness();
  const threads = Layer.effect(
    ThreadManagementService,
    Effect.gen(function* () {
      const original = yield* ThreadManagementService;
      return {
        ...original,
        getThreadShell: Effect.fn("test.completedShell")((id: ThreadId) =>
          original
            .getThreadShell(id)
            .pipe(
              Effect.map((shell) =>
                shell === null
                  ? null
                  : { ...shell, latestRunCompletedAt: completed ? completedAt : null },
              ),
            ),
        ),
      };
    }),
  ).pipe(Layer.provide(harness.layer));
  return ThreadReads.layer.pipe(
    Layer.provideMerge(threads),
    Layer.provideMerge(PersonAccess.layer),
    Layer.provideMerge(humanPersonRegistryLayer),
    Layer.provideMerge(harness.layer),
  );
}

const seed = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Personal read state",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  return yield* ThreadReads.ThreadReadState;
});

const viewer = Effect.fn("test.viewer")(function* (name: string) {
  const access = yield* PersonAccess.PersonAccess;
  const person = yield* access.createPerson({ displayName: name });
  yield* access.setLevel({
    personId: person.personId,
    scope: { kind: "thread", threadId },
    level: "viewer",
  });
  const session = { sessionId: AuthSessionId.make(`session:${name}`), subject: "one-time-token" };
  yield* access.bindSession({
    sessionId: session.sessionId,
    personId: person.personId,
    ceiling: ["orchestration:read"],
  });
  return { person, session };
});

const feed = Effect.fn("test.readFeed")(function* (session: PersonAccess.SessionIdentity) {
  const reads = yield* ThreadReads.ThreadReadState;
  const queue = yield* Queue.unbounded<PersonalThreadReadChange>();
  yield* reads.subscribe(session).pipe(
    Stream.runForEach((change) => Queue.offer(queue, change)),
    Effect.forkChild,
  );
  return queue;
});

it.effect("preserves search-open ranking without advancing the shared read marker", () =>
  Effect.gen(function* () {
    const reads = yield* seed;
    const threads = yield* ThreadManagementService;
    const previous = "2026-10-30T00:00:00.000Z";
    yield* threads.dispatch({
      type: "thread.visit",
      threadId,
      commandId: CommandId.make("legacy"),
      visitedAt: previous,
    });
    yield* reads.visit(owner, {
      commandId: CommandId.make("owner-open"),
      threadId,
      visitedAt: readAt,
      opened: true,
      searchQuery: "quartz",
    });
    const sql = yield* SqlClient.SqlClient;
    const [before] = yield* sql<{
      readonly opens: string;
      readonly visited: string;
    }>`SELECT json_extract(payload_json, '$.opens') AS opens, json_extract(payload_json, '$.lastVisitedAt') AS visited FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    assert.include(before!.opens, "quartz");
    assert.equal(before!.visited, previous);
    const alice = yield* viewer("Alice");
    yield* reads.visit(alice.session, {
      commandId: CommandId.make("viewer-open"),
      threadId,
      visitedAt: readAt,
      opened: true,
      searchQuery: "violet",
    });
    const [after] = yield* sql<{
      readonly opens: string;
      readonly visited: string;
    }>`SELECT json_extract(payload_json, '$.opens') AS opens, json_extract(payload_json, '$.lastVisitedAt') AS visited FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    assert.deepEqual(after, before);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "keeps two people's markers independent and sends a viewer's changes to both their devices",
  () =>
    Effect.gen(function* () {
      const reads = yield* seed;
      const alice = yield* viewer("Alice");
      const bob = yield* viewer("Bob");
      const access = yield* PersonAccess.PersonAccess;
      const second = { ...alice.session, sessionId: AuthSessionId.make("session:alice-phone") };
      yield* access.bindSession({
        sessionId: second.sessionId,
        personId: alice.person.personId,
        ceiling: ["orchestration:read"],
      });
      const aliceFeed = yield* feed(alice.session);
      const phoneFeed = yield* feed(second);
      const bobFeed = yield* feed(bob.session);
      for (const queue of [aliceFeed, phoneFeed, bobFeed])
        assert.deepEqual(yield* Queue.take(queue), { kind: "snapshot", markers: [] });
      const marker = yield* reads.visit(alice.session, {
        commandId: CommandId.make("alice-read"),
        threadId,
        visitedAt: readAt,
      });
      for (const queue of [aliceFeed, phoneFeed])
        assert.deepEqual(yield* Queue.take(queue), { kind: "changed", marker });
      const bobMarker = yield* reads.visit(bob.session, {
        commandId: CommandId.make("bob-read"),
        threadId,
        visitedAt: readAt,
      });
      assert.deepEqual(yield* Queue.take(bobFeed), { kind: "changed", marker: bobMarker });
      const unread = yield* reads.markUnread(second, {
        commandId: CommandId.make("alice-unread"),
        threadId,
      });
      assert.equal(DateTime.formatIso(unread.lastVisitedAt), "2026-10-31T11:59:59.999Z");
      for (const queue of [aliceFeed, phoneFeed])
        assert.deepEqual(yield* Queue.take(queue), { kind: "changed", marker: unread });
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT person_id, last_visited_at FROM j5_thread_read ORDER BY person_id`,
        [
          { person_id: alice.person.personId, last_visited_at: "2026-10-31T11:59:59.999Z" },
          { person_id: bob.person.personId, last_visited_at: readAt },
        ].sort((a, b) => a.person_id.localeCompare(b.person_id)),
      );
      assert.isNull(
        (yield* (yield* ThreadManagementService).getThreadShell(threadId))?.lastVisitedAt,
      );
      const restored = yield* Effect.gen(function* () {
        const fresh = yield* ThreadReads.ThreadReadState;
        return yield* fresh.subscribe(second).pipe(Stream.take(1), Stream.runCollect);
      }).pipe(Effect.provide(ThreadReads.layer));
      assert.deepEqual(restored, [{ kind: "snapshot", markers: [unread] }]);
    }).pipe(Effect.provide(layer())),
);

it.effect("replays retries without undoing newer actions and rejects reused command ids", () =>
  Effect.gen(function* () {
    const reads = yield* seed;
    const visit = { commandId: CommandId.make("read"), threadId, visitedAt: readAt };
    const original = yield* reads.visit(owner, visit);
    const unreadInput = { commandId: CommandId.make("unread"), threadId };
    yield* reads.markUnread(owner, unreadInput);
    assert.deepEqual(yield* reads.visit(owner, visit), original);
    const [snapshot] = yield* reads.subscribe(owner).pipe(Stream.take(1), Stream.runCollect);
    assert.equal(
      snapshot?.kind === "snapshot" && DateTime.formatIso(snapshot.markers[0]!.lastVisitedAt),
      "2026-10-31T11:59:59.999Z",
    );
    yield* reads.visit(owner, { ...visit, commandId: CommandId.make("new-read") });
    yield* reads.markUnread(owner, unreadInput);
    yield* reads.visit(owner, {
      ...visit,
      commandId: CommandId.make("stale-read"),
      visitedAt: "2026-10-30T00:00:00.000Z",
    });
    const [current] = yield* reads.subscribe(owner).pipe(Stream.take(1), Stream.runCollect);
    assert.equal(
      current?.kind === "snapshot" && DateTime.formatIso(current.markers[0]!.lastVisitedAt),
      readAt,
    );
    const conflict = yield* reads
      .markUnread(owner, { commandId: visit.commandId, threadId })
      .pipe(Effect.flip);
    assert.equal(conflict.reason, "request-conflict");
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "refuses unknown devices and inaccessible threads and removes revoked access from snapshots",
  () =>
    Effect.gen(function* () {
      const reads = yield* seed;
      const alice = yield* viewer("Alice");
      const input = { commandId: CommandId.make("read"), threadId, visitedAt: readAt };
      assert.equal(
        (yield* reads
          .visit({ sessionId: AuthSessionId.make("unknown"), subject: "one-time-token" }, input)
          .pipe(Effect.flip)).reason,
        "not-person",
      );
      assert.equal(
        (yield* reads
          .visit(alice.session, { ...input, threadId: ThreadId.make("not-shared") })
          .pipe(Effect.flip)).reason,
        "not-shared",
      );
      yield* reads.visit(alice.session, input);
      const queue = yield* feed(alice.session);
      yield* Queue.take(queue);
      yield* (yield* PersonAccess.PersonAccess).removeLevel({
        personId: alice.person.personId,
        scope: { kind: "thread", threadId },
      });
      assert.deepEqual(yield* Queue.take(queue), { kind: "snapshot", markers: [] });
      assert.equal(
        (yield* reads
          .markUnread(alice.session, { commandId: CommandId.make("denied"), threadId })
          .pipe(Effect.flip)).reason,
        "not-shared",
      );
    }).pipe(Effect.provide(layer())),
);

it.effect("refuses mark unread without a completed run", () =>
  Effect.gen(function* () {
    const reads = yield* seed;
    assert.equal(
      (yield* reads
        .markUnread(owner, { commandId: CommandId.make("unread"), threadId })
        .pipe(Effect.flip)).reason,
      "no-completion",
    );
  }).pipe(Effect.provide(layer(false))),
);

it.effect("migrates existing markers only to the first owner", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* viewer("Alice");
    const reach = yield* (yield* PersonAccess.PersonAccess).sessionReach(owner);
    assert.equal(reach.kind, "person");
    if (reach.kind !== "person") return;
    yield* (yield* ThreadManagementService).dispatch({
      type: "thread.visit",
      commandId: CommandId.make("legacy-read"),
      threadId,
      visitedAt: readAt,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE j5_thread_read`;
    yield* sql`DROP TABLE j5_thread_read_command`;
    yield* migration;
    assert.deepEqual(yield* sql`SELECT * FROM j5_thread_read`, [
      { person_id: reach.person.personId, thread_id: threadId, last_visited_at: readAt },
    ]);
  }).pipe(Effect.provide(layer())),
);
