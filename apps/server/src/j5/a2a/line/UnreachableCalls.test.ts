import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { CommEvent } from "../contracts.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2ALedgerTransactionWriter } from "../LedgerService.ts";
import { PeerRegistryService } from "../PeerRegistryService.ts";
import { LineClosedError } from "./LineMux.ts";
import { LineRegistry, type LineUp } from "./LineRegistry.ts";
import { layer as unreachableCallsLayer } from "./UnreachableCalls.ts";
import { UnreachableCalls } from "./UnreachableCallsService.ts";

const LAPTOP = "environment-laptop";
const DESK = "environment-desk";
const writer = ThreadId.make("thread-writer");
const reviewer = ThreadId.make("thread-reviewer");
const archived = ThreadId.make("thread-archived");
const participant = (thread: ThreadId) => `agent:j5:a2a:${thread}`;

const unanswered = new OrchestratorMcpFailure({
  code: "peer_unreachable",
  message: "Laptop did not answer.",
});

const setup = Effect.gen(function* () {
  const current = new Map<string, string>();
  const ups = yield* PubSub.unbounded<LineUp>();
  const peers = new Map<string, { linkMode: "store" | "push"; label: string; createdAt: string }>([
    [LAPTOP, { linkMode: "store", label: "Laptop", createdAt: "1970-01-01T00:00:00.000Z" }],
    [DESK, { linkMode: "push", label: "Desk", createdAt: "1970-01-01T00:00:00.000Z" }],
  ]);
  const notices = yield* Queue.unbounded<CommEvent>();
  const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(database, SqlClient.SqlClient);
  yield* sql`
    CREATE TABLE j5_a2a_membership (
      project_id TEXT, participant_id TEXT, participant_kind TEXT, thread_id TEXT, archived_at TEXT
    )
  `;
  for (const [thread, archivedAt] of [
    [writer, null],
    [reviewer, null],
    [archived, "1970-01-01T00:00:00.000Z"],
  ] as const) {
    yield* sql`
      INSERT INTO j5_a2a_membership
      VALUES ('project-billing', ${participant(thread)}, 'agent', ${thread}, ${archivedAt})
    `;
  }
  const context = yield* Layer.build(
    unreachableCallsLayer.pipe(
      Layer.provide(
        Layer.mock(LineRegistry)({
          connect: () => new LineClosedError("Not used here."),
          currentLineId: (environmentId) => current.get(environmentId) ?? null,
          subscribeUps: Effect.map(PubSub.subscribe(ups), Stream.fromSubscription),
        }),
      ),
      Layer.provide(
        Layer.mock(PeerRegistryService)({
          get: (environmentId) => {
            const peer = peers.get(environmentId);
            return Effect.succeed(
              peer === undefined
                ? null
                : {
                    environmentId,
                    label: peer.label,
                    linkMode: peer.linkMode,
                    origin: null,
                    credentialExpiresAt: null,
                    inboundSession: "active" as const,
                    createdAt: peer.createdAt,
                    lastPolledAt: null,
                    lastError: null,
                    waitingCount: 0,
                    oldestWaitingAt: null,
                    lineAddress: null,
                  },
            );
          },
        }),
      ),
      Layer.provide(
        Layer.mock(A2ALedgerTransactionWriter)({
          withPermit: (effect) => effect,
          appendEventsInTransaction: (command) =>
            Queue.offerAll(notices, command.events).pipe(
              Effect.as({ committed: true, events: [] } as never),
            ),
          publishCommitted: () => Effect.void,
        }),
      ),
      Layer.provide(Layer.mock(A2ADeliveryWorker)({ notify: Effect.void })),
      Layer.provide(Layer.succeedContext(database)),
    ),
  );
  const calls = Context.get(context, UnreachableCalls);
  /** A call that fails because its server did not answer; `during` runs while it is out. */
  const fail = (thread: ThreadId, environmentId: string, tool: string, during = () => {}) =>
    Effect.flip(
      calls.observe(
        { threadId: thread, environmentId, tool },
        Effect.suspend(() => {
          during();
          return Effect.fail(unanswered);
        }),
      ),
    );
  const lineUp = (environmentId: string, lineId: string) =>
    Effect.sync(() => current.set(environmentId, lineId)).pipe(
      Effect.andThen(PubSub.publish(ups, { environmentId, lineId })),
    );
  const nextNotice = Queue.take(notices).pipe(
    Effect.map((event) => ({
      receiver: String(event.receiver),
      messageId:
        typeof event.payload === "object" &&
        event.payload !== null &&
        "messageId" in event.payload &&
        typeof event.payload.messageId === "string"
          ? event.payload.messageId
          : "",
      text:
        typeof event.payload === "object" &&
        event.payload !== null &&
        "text" in event.payload &&
        typeof event.payload.text === "string"
          ? event.payload.text
          : "",
    })),
  );
  /** An up event for a line that is not the current one, as when it closed again before being handled. */
  const staleUp = (environmentId: string, lineId: string) =>
    PubSub.publish(ups, { environmentId, lineId });
  return { current, peers, notices, fail, lineUp, staleUp, nextNotice };
});

it.effect("tells each thread once, when the line it could not reach comes back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      line.current.set(LAPTOP, "line-1");
      yield* line.fail(writer, LAPTOP, "t3_thread_launch");
      yield* line.fail(writer, LAPTOP, "delegate_task");
      yield* line.fail(reviewer, LAPTOP, "t3_thread_read");
      yield* line.fail(archived, LAPTOP, "t3_queue");
      // A server this one sends to directly holds no line here.
      yield* line.fail(writer, DESK, "t3_thread_read");
      assert.strictEqual(yield* Queue.size(line.notices), 0, "nothing is said until a new line");

      yield* line.lineUp(LAPTOP, "line-2");
      const notices = [yield* line.nextNotice, yield* line.nextNotice];
      const byThread = new Map(notices.map((notice) => [notice.receiver, notice.text]));
      const toWriter = byThread.get(participant(writer))!;
      assert.include(toWriter, "Laptop is reachable again.");
      assert.include(toWriter, "- t3_thread_launch at ");
      assert.include(toWriter, "- delegate_task at ");
      assert.notInclude(toWriter, "t3_thread_read", "a direct peer's call is not listed");
      assert.include(byThread.get(participant(reviewer))!, "- t3_thread_read at ");
      assert.isFalse(byThread.has(participant(archived)), "an archived thread is not told");

      // A call that fails on the line that is up waits for the next line, and only it is told then.
      yield* line.fail(writer, LAPTOP, "t3_thread_wait");
      yield* line.lineUp(LAPTOP, "line-3");
      const later = yield* line.nextNotice;
      assert.include(later.text, "- t3_thread_wait at ");
      assert.notInclude(later.text, "t3_thread_launch", "each call is told once");
      assert.strictEqual(yield* Queue.size(line.notices), 0);

      // An up event for a line that already closed again sends nothing; the next line's does.
      yield* line.fail(reviewer, LAPTOP, "t3_thread_list");
      yield* line.staleUp(LAPTOP, "line-gone");
      yield* line.lineUp(LAPTOP, "line-4");
      const afterStale = yield* line.nextNotice;
      assert.include(afterStale.messageId, "line-4");
      assert.include(afterStale.text, "- t3_thread_list at ");
      assert.strictEqual(yield* Queue.size(line.notices), 0);
    }),
  ),
);

it.effect("tells a thread at once when the line already came back while its call was out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      yield* line.fail(writer, LAPTOP, "t3_project_list", () => line.current.set(LAPTOP, "line-1"));
      const notice = yield* line.nextNotice;
      assert.strictEqual(notice.receiver, participant(writer));
      assert.include(notice.text, "- t3_project_list at ");
    }),
  ),
);

it.effect("leaves out calls from before the peer was recorded again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const line = yield* setup;
      yield* line.fail(writer, LAPTOP, "t3_thread_launch");
      // Removed and peered again: a new record, and calls made after it.
      yield* TestClock.adjust("2 seconds");
      line.peers.set(LAPTOP, {
        linkMode: "store",
        label: "Laptop",
        createdAt: "1970-01-01T00:00:01.000Z",
      });
      yield* line.fail(reviewer, LAPTOP, "t3_thread_read");
      yield* line.lineUp(LAPTOP, "line-1");
      const only = yield* line.nextNotice;
      assert.strictEqual(only.receiver, participant(reviewer));

      // A call that began before the peer was recorded again, failing once its new line is up.
      yield* line.fail(writer, LAPTOP, "t3_queue", () => {
        line.peers.set(LAPTOP, {
          linkMode: "store",
          label: "Laptop",
          createdAt: "1970-01-01T00:00:05.000Z",
        });
        line.current.set(LAPTOP, "line-2");
      });
      assert.strictEqual(yield* Queue.size(line.notices), 0);
    }),
  ),
);
