import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import { makePlaybookStore } from "../playbooks/PlaybookStore.ts";
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

it.effect("attributes a private Owner's launch and chat turns through real message events", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const admission = yield* makeCommandAdmission(() => Effect.void, {
      sessionId: AuthSessionId.make("session:private-owner"),
      subject: "administrative-bootstrap",
    });
    const threads = yield* ThreadManagementService;
    const launches = yield* ThreadLaunchService;
    const store = yield* makePlaybookStore;
    const yaml =
      "title: Review\ndescription: Review a change.\nsteps:\n  - id: review\n    title: Review\n    prompt: Read the change.\n";
    const launchInput = {
      projectId,
      title: "Private author",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    } as const;
    // The initial message and its thread can both have ids allocated by upstream.
    const launch = (input: Parameters<typeof admission.launchThread>[0]) =>
      admission.launchThread(input, (admitted) =>
        launches.launch({
          ...launchInput,
          commandId: admitted.commandId,
          ...(admitted.initialMessage === undefined
            ? {}
            : {
                initialMessage: {
                  text: admitted.initialMessage.text,
                  attachments: admitted.initialMessage.attachments,
                },
              }),
          createdBy: "user",
          creationSource: "web",
        }),
      );
    const first = yield* launch({
      ...launchInput,
      commandId: CommandId.make("command:private-launch"),
      initialMessage: { text: "Save the approved draft.", attachments: [] },
    });
    const firstRun = (yield* threads.getThreadShell(first.threadId))?.activeRunId;
    assert.isNotNull(firstRun);
    yield* threads.dispatch({
      type: "prepared-run.release",
      commandId: CommandId.make("command:private-launch:release"),
      threadId: first.threadId,
      runId: firstRun!,
    });
    assert.deepStrictEqual(
      yield* store.saveDefinitionFromTurn(first.threadId, firstRun ?? null, {
        name: "launch",
        yaml,
      }),
      { name: "launch", saved: true },
    );

    const next = yield* launch({
      ...launchInput,
      commandId: CommandId.make("command:private-empty-launch"),
    });
    yield* admission.dispatchCommand(
      {
        type: "message.dispatch",
        threadId: next.threadId,
        commandId: CommandId.make("command:private-message"),
        messageId: MessageId.make("message:private-message"),
        text: "Save the approved draft.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      },
      threads.dispatch,
    );
    const nextRun = (yield* threads.getThreadShell(next.threadId))?.activeRunId ?? null;
    assert.isNotNull(nextRun);
    assert.deepStrictEqual(
      yield* store.saveDefinitionFromTurn(next.threadId, nextRun, { name: "message", yaml }),
      { name: "message", saved: true },
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerFor(harness),
        ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-attribution-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
