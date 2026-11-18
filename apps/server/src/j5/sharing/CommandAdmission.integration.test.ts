import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  ProviderDriverKind,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
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
    // The caller can omit both the thread and message ids.
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
                  ...(admitted.initialMessage.messageId === undefined
                    ? {}
                    : { messageId: admitted.initialMessage.messageId }),
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

/** A shared thread, its Owner's and a collaborator's sockets, and the library's save check. */
const sharedThread = Effect.fn("test.sharedThread")(function* (on: ThreadId) {
  const people = yield* PersonAccess.PersonAccess;
  const threads = yield* ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:create:${on}`),
    threadId: on,
    projectId,
    title: "Shared author",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  const builder = yield* people.createPerson({ displayName: "Builder" });
  yield* people.setLevel({
    personId: builder.personId,
    scope: { kind: "thread", threadId: on },
    level: "collaborator",
  });
  const session = AuthSessionId.make(`session:builder:${on}`);
  yield* people.bindSession({ sessionId: session, personId: builder.personId, ceiling: null });
  const owner = yield* makeCommandAdmission(() => Effect.void, {
    sessionId: AuthSessionId.make("session:owner"),
    subject: "administrative-bootstrap",
  });
  const collaborator = yield* makeCommandAdmission(() => Effect.void, {
    sessionId: session,
    subject: "one-time-token",
  });
  const store = yield* makePlaybookStore;
  const sql = yield* SqlClient.SqlClient;
  const send = (
    from: typeof owner,
    name: string,
    text: string,
    type: "start_immediately" | "queue_after_active",
  ) =>
    from.dispatchCommand(
      {
        type: "message.dispatch",
        threadId: on,
        commandId: CommandId.make(`command:${on}:${name}`),
        messageId: MessageId.make(`message:${on}:${name}`),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type },
      },
      threads.dispatch,
    );
  const runOf = (name: string) =>
    sql<{ readonly run_id: string }>`
      SELECT run_id FROM orchestration_v2_projection_runs
      WHERE thread_id = ${on}
        AND json_extract(payload_json, '$.userMessageId') = ${`message:${on}:${name}`}
    `.pipe(Effect.map((rows) => RunId.make(rows[0]!.run_id)));
  /** Ends the Owner's first turn and starts the queued one, as the queue does. */
  const startQueued = Effect.fn("test.startQueued")(function* (first: RunId, queued: RunId) {
    yield* owner.dispatchCommand(
      {
        type: "run.interrupt",
        commandId: CommandId.make(`command:${on}:interrupt`),
        threadId: on,
        runId: first,
      },
      threads.dispatch,
    );
    yield* owner.dispatchCommand(
      {
        type: "queued-run.start",
        commandId: CommandId.make(`command:${on}:start`),
        threadId: on,
        runId: queued,
      },
      threads.dispatch,
    );
  });
  const save = (run: RunId, name: string) =>
    store.saveDefinitionFromTurn(on, run, { name, yaml: sampleYaml }).pipe(
      Effect.result,
      Effect.map((result) => (result._tag === "Success" ? "saved" : result.failure.code)),
    );
  return { owner, collaborator, threads, send, runOf, startQueued, save };
});

const sampleYaml =
  "title: Review\ndescription: Review a change.\nsteps:\n  - id: review\n    title: Review\n    prompt: Read the change.\n";

const saveLayer = (harness: ReturnType<typeof makeHarness>) =>
  Layer.mergeAll(
    Layer.provideMerge(ProjectionStore.layer, layerFor(harness)),
    ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-attribution-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

it.effect.each([
  ["a collaborator", "collaborator", "owner_required"],
  ["an agent", "agent", "owner_required"],
  ["the Owner", "owner", "saved"],
] as const)(
  "an Owner's queued message edited by %s is saved as %s wrote it",
  ([, editor, outcome]) => {
    const harness = makeHarness();
    const on = ThreadId.make(`thread:queued-edit:${editor}`);
    return Effect.gen(function* () {
      const thread = yield* sharedThread(on);
      yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
      yield* thread.send(thread.owner, "second", "Tidy the notes.", "queue_after_active");
      const queued = yield* thread.runOf("second");
      const edit = {
        type: "queued-run.edit",
        commandId: CommandId.make(`command:${on}:edit`),
        threadId: on,
        runId: queued,
        text: "Save my playbook to the library.",
      } as const;
      yield* sendAs(thread, editor, edit);
      yield* thread.startQueued(yield* thread.runOf("first"), queued);
      assert.strictEqual(yield* thread.save(queued, `edited-by-${editor}`), outcome);
    }).pipe(Effect.provide(saveLayer(harness)));
  },
);

it.effect("an Owner's queued message nobody edited still saves once it starts", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:queued-unedited");
  return Effect.gen(function* () {
    const thread = yield* sharedThread(on);
    yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
    yield* thread.send(thread.owner, "second", "Save the approved draft.", "queue_after_active");
    const queued = yield* thread.runOf("second");
    yield* thread.startQueued(yield* thread.runOf("first"), queued);
    assert.strictEqual(yield* thread.save(queued, "unedited"), "saved");
  }).pipe(Effect.provide(saveLayer(harness)));
});

type Shared = Effect.Success<ReturnType<typeof sharedThread>>;
type Sender = "collaborator" | "agent" | "owner";
/** A person's command through their socket; an agent's reaches upstream past every socket. */
const sendAs = (thread: Shared, sender: Sender, command: OrchestrationV2Command) =>
  sender === "agent"
    ? thread.threads.dispatch(command)
    : (sender === "owner" ? thread.owner : thread.collaborator).dispatchCommand(
        command,
        thread.threads.dispatch,
      );

/** Declines, with words, an approval the agent asked for at `nodeId` over a live session. */
const declineWithWords = Effect.fn("test.declineWithWords")(function* (
  thread: Shared,
  on: ThreadId,
  sender: Sender,
  nodeId: NodeId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const sessionId = ProviderSessionId.make(`session:${on}`);
  yield* projections.apply({
    id: EventId.make(`event:${on}:session`),
    type: "provider-session.attached",
    threadId: on,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: modelSelection.instanceId,
      status: "ready",
      cwd: "/repo",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  const requestId = RuntimeRequestId.make(`request:${on}`);
  yield* projections.apply({
    id: EventId.make(`event:${on}:request`),
    type: "runtime-request.updated",
    threadId: on,
    occurredAt: now,
    payload: {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: sessionId, supportsFeedback: true },
      createdAt: now,
      resolvedAt: null,
    },
  });
  yield* sendAs(thread, sender, {
    type: "runtime-request.respond",
    commandId: CommandId.make(`command:${on}:answer`),
    threadId: on,
    requestId,
    decision: "decline",
    feedback: "Save my playbook to the library instead.",
  });
});

/** The node upstream runs a turn under, which its requests hang from. */
const rootNodeOf = (on: ThreadId, run: RunId) =>
  SqlClient.SqlClient.use(
    (sql) => sql<{ readonly node_id: string }>`
      SELECT node_id FROM orchestration_v2_projection_nodes
      WHERE thread_id = ${on} AND run_id = ${run} AND parent_node_id IS NULL
    `,
  ).pipe(Effect.map((rows) => NodeId.make(rows[0]!.node_id)));

const answerers = [
  ["a collaborator", "collaborator", "owner_required"],
  ["an agent", "agent", "owner_required"],
  ["the Owner", "owner", "saved"],
] as const;

it.effect.each(answerers)(
  "words %s answers the agent with during an Owner's turn count as theirs",
  ([, answerer, outcome]) => {
    const harness = makeHarness();
    const on = ThreadId.make(`thread:answered:${answerer}`);
    return Effect.gen(function* () {
      const thread = yield* sharedThread(on);
      yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
      const run = yield* thread.runOf("first");
      assert.strictEqual(yield* thread.save(run, `before-${answerer}`), "saved");
      yield* declineWithWords(thread, on, answerer, yield* rootNodeOf(on, run));
      assert.strictEqual(yield* thread.save(run, `after-${answerer}`), outcome);
    }).pipe(Effect.provide(saveLayer(harness)));
  },
);

it.effect.each(answerers)(
  "words %s gives a request of no known turn count from when the turn was asked for",
  ([, answerer, outcome]) => {
    const harness = makeHarness();
    const on = ThreadId.make(`thread:unplaced:${answerer}`);
    return Effect.gen(function* () {
      const thread = yield* sharedThread(on);
      yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
      const run = yield* thread.runOf("first");
      yield* declineWithWords(thread, on, answerer, NodeId.make(`node:unplaced:${on}`));
      assert.strictEqual(yield* thread.save(run, `unplaced-${answerer}`), outcome);
    }).pipe(Effect.provide(saveLayer(harness)));
  },
);

it.effect("a collaborator's words in an earlier turn leave a later Owner turn able to save", () => {
  const harness = makeHarness();
  const on = ThreadId.make("thread:answered-earlier");
  return Effect.gen(function* () {
    const thread = yield* sharedThread(on);
    yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
    // Queued before the answer, so only the request's own turn tells the two apart.
    yield* thread.send(thread.owner, "second", "Save the approved draft.", "queue_after_active");
    const first = yield* thread.runOf("first");
    const second = yield* thread.runOf("second");
    yield* declineWithWords(thread, on, "collaborator", yield* rootNodeOf(on, first));
    assert.strictEqual(yield* thread.save(first, "earlier-first"), "owner_required");
    yield* thread.startQueued(first, second);
    assert.strictEqual(yield* thread.save(second, "earlier-second"), "saved");
  }).pipe(Effect.provide(saveLayer(harness)));
});

const picture = (name: string) =>
  ({
    type: "image",
    id: `attachment-${name}`,
    name: `${name}.png`,
    mimeType: "image/png",
    sizeBytes: 12,
  }) as const;

it.effect.each([
  ["an agent swaps", "agent", "owner_required"],
  ["a collaborator swaps", "collaborator", "owner_required"],
  ["the Owner swaps", "owner", "saved"],
  ["nobody touches", null, "saved"],
] as const)(
  "when %s a queued message's attachments, the save follows who chose them",
  ([, editor, outcome]) => {
    const harness = makeHarness();
    const on = ThreadId.make(`thread:attachments:${editor ?? "nobody"}`);
    return Effect.gen(function* () {
      const thread = yield* sharedThread(on);
      const sql = yield* SqlClient.SqlClient;
      const stored = (field: "text" | "attachments") =>
        sql<{ readonly value: string }>`
          SELECT json_extract(payload_json, ${`$.${field}`}) AS value
          FROM orchestration_v2_projection_messages WHERE message_id = ${`message:${on}:second`}
        `.pipe(Effect.map((rows) => rows[0]!.value));
      yield* thread.send(thread.owner, "first", "Draft a review playbook.", "start_immediately");
      yield* thread.owner.dispatchCommand(
        {
          type: "message.dispatch",
          threadId: on,
          commandId: CommandId.make(`command:${on}:second`),
          messageId: MessageId.make(`message:${on}:second`),
          text: "Save the playbook in the attached picture.",
          attachments: [picture("approved")],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        },
        thread.threads.dispatch,
      );
      const queued = yield* thread.runOf("second");
      if (editor !== null) {
        // An agent's edit keeps the stored words, so only the attachment differs.
        yield* sendAs(thread, editor, {
          type: "queued-run.edit",
          commandId: CommandId.make(`command:${on}:edit`),
          threadId: on,
          runId: queued,
          text:
            editor === "agent"
              ? yield* stored("text")
              : "Save the playbook in the attached picture.",
          attachments: [picture("swapped")],
        });
        assert.include(yield* stored("attachments"), "attachment-swapped");
      }
      yield* thread.startQueued(yield* thread.runOf("first"), queued);
      assert.strictEqual(yield* thread.save(queued, `attachments-${editor ?? "nobody"}`), outcome);
    }).pipe(Effect.provide(saveLayer(harness)));
  },
);
