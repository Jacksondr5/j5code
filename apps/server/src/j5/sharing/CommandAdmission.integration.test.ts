import { assert, it } from "@effect/vitest";
import { AuthSessionId, CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
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
    Layer.provide(harness.orchestrator),
    Layer.provideMerge(harness.layer),
    Layer.provideMerge(ProviderRegistryMock.layer()),
  );

it.effect("refuses legacy read writes before they can affect anyone else's state", () => {
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
    const admission = yield* makeCommandAdmission(() => Effect.void, {
      sessionId: session,
      subject: "one-time-token",
    });
    const base = { commandId: CommandId.make("command:visit:legacy"), threadId };
    for (const command of [
      { ...base, type: "thread.visit", visitedAt: "2026-10-31T00:00:00.000Z", opened: true },
      { ...base, type: "thread.mark-unread" },
    ] as const) {
      const error = yield* admission.dispatchCommand(command, threads.dispatch).pipe(Effect.flip);
      assert.include(error.message, "Use personal thread read commands.");
    }
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly visited: string | null }>`
      SELECT json_extract(payload_json, '$.lastVisitedAt') AS visited
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    assert.isNull(row!.visited);
  }).pipe(Effect.provide(layerFor(harness)));
});
