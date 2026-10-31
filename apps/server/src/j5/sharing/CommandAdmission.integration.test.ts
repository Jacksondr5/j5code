import { assert, it } from "@effect/vitest";
import { AuthSessionId, CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { humanPersonRegistryLayer } from "../a2a/HumanPersonRegistry.ts";
import { makeHarness, modelSelection, projectId } from "../test-support/threadLaunchHarness.ts";
import { makeCommandAdmission } from "./CommandAdmission.ts";
import * as PersonAccess from "./PersonAccess.ts";
import * as SharedConversation from "./SharedConversation.ts";
import * as SharedThreads from "./SharedThreads.ts";
import { quietAccessLayer, quietLifecycleLayer } from "./test-support/conversationHarness.ts";

/** Visits through J5's admission into upstream's real orchestrator and projections. */

const threadId = ThreadId.make("thread:visited");

const layerFor = (harness: ReturnType<typeof makeHarness>) =>
  SharedConversation.layer.pipe(
    Layer.provideMerge(SharedThreads.layer),
    Layer.provide(quietAccessLayer),
    Layer.provide(quietLifecycleLayer),
    Layer.provideMerge(PersonAccess.layer),
    Layer.provideMerge(humanPersonRegistryLayer),
    Layer.provideMerge(harness.layer),
  );

let counter = 0;
/** What upstream's palette sends when a thread is opened from a search. */
const visit = Effect.fn("test.visit")(function* (
  session: PersonAccess.SessionIdentity,
  searchQuery: string,
) {
  counter += 1;
  const admission = yield* makeCommandAdmission(() => Effect.void, session);
  const threads = yield* ThreadManagementService;
  yield* admission.dispatchCommand(
    {
      type: "thread.visit",
      commandId: CommandId.make(`command:visit:${counter}`),
      threadId,
      visitedAt: `2026-10-31T00:00:0${counter}.000Z`,
      opened: true,
      searchQuery,
    },
    threads.dispatch,
  );
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly opens: string | null; readonly visited: string | null }>`
    SELECT json_extract(payload_json, '$.opens') AS opens,
      json_extract(payload_json, '$.lastVisitedAt') AS visited
    FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
  `;
  return row!;
});

it.effect("a shared person's visit moves the read marker and leaves the owner's opens", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const people = yield* PersonAccess.PersonAccess;
    const threads = yield* ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:visit:create"),
      threadId,
      projectId,
      title: "Visited",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    const owner = yield* visit(
      {
        sessionId: AuthSessionId.make("session:owner"),
        subject: "administrative-bootstrap",
      },
      "amberquartz",
    );
    assert.isNotNull(owner.opens);
    assert.include(owner.opens!, "amberquartz");

    const collaborator = yield* people.createPerson({ displayName: "Builder" });
    yield* people.setLevel({
      personId: collaborator.personId,
      scope: { kind: "thread", threadId },
      level: "collaborator",
    });
    const session = AuthSessionId.make("session:builder");
    yield* people.bindSession({
      sessionId: session,
      personId: collaborator.personId,
      ceiling: null,
    });
    // Past upstream's window that folds two opens into one.
    yield* TestClock.adjust("1 day");
    const shared = yield* visit({ sessionId: session, subject: "one-time-token" }, "violetvault");
    assert.strictEqual(shared.opens, owner.opens);
    assert.isTrue(shared.visited! > owner.visited!);
  }).pipe(Effect.provide(layerFor(harness)));
});
