import { testExecution } from "./testFixtures.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ThreadLaunchService,
  ThreadLaunchError,
  type ThreadLaunchInput,
} from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { findActionRun, makeAgentAdapter, readAgentOutput } from "./AgentAdapter.ts";
import type { Action, Run } from "@j5/playbook-contracts";

const review = { verdict: "accept", subjectHash: "plan-hash", findings: [] };
const reviewJson = JSON.stringify(review);
const fencedReview = `\`\`\`json\n${reviewJson}\n\`\`\``;

it.effect.each([
  { name: "plain JSON", text: reviewJson },
  { name: "a single JSON fence", text: fencedReview },
  { name: "a fence surrounded by prose", text: `Wrote the critique.\n\n${fencedReview}\nDone.` },
  { name: "an unlabelled fence", text: `\`\`\`\n${reviewJson}\n\`\`\`` },
  { name: "CRLF fences", text: `\`\`\`JSON\r\n${reviewJson}\r\n\`\`\`` },
])("reads the current run's final answer from $name", ({ text }) =>
  Effect.gen(function* () {
    const output = yield* readAgentOutput(
      [
        { runId: "owned", role: "assistant", text: "Checking the evidence." },
        { runId: "owned", role: "assistant", text },
        { runId: "other", role: "assistant", text: '{"summary":"unrelated"}' },
        { runId: "owned", role: "user", text: "Thanks" },
      ],
      "owned",
    );
    assert.deepEqual(output, review);
  }),
);

it.effect.each([
  { name: "malformed JSON", text: '{"verdict":' },
  { name: "malformed fenced JSON", text: '```json\n{"verdict":\n```' },
  { name: "an unclosed fence", text: `\`\`\`json\n${reviewJson}` },
  { name: "multiple JSON fences", text: `${fencedReview}\n${fencedReview}` },
  { name: "another code block", text: `\`\`\`text\nExample\n\`\`\`\n${fencedReview}` },
  { name: "another tilde code block", text: `~~~json\n${reviewJson}\n~~~\n${fencedReview}` },
  { name: "another object outside the fence", text: `${reviewJson}\n${fencedReview}` },
  { name: "another array outside the fence", text: `${fencedReview}\n[]` },
  { name: "unfenced prose and JSON", text: `Example: ${reviewJson}` },
  { name: "the wrong fence language", text: `\`\`\`javascript\n${reviewJson}\n\`\`\`` },
  { name: "an invalid final answer after valid earlier JSON", text: "I could not finish." },
  { name: "an empty final answer", text: "" },
])("preserves $name for normal invalid-output handling", ({ text }) =>
  Effect.gen(function* () {
    const output = yield* readAgentOutput(
      [
        { runId: "owned", role: "assistant", text: reviewJson },
        { runId: "owned", role: "assistant", text },
      ],
      "owned",
    );
    assert.strictEqual(output, text);
  }),
);

it.effect("does not combine incomplete messages into a synthetic JSON result", () =>
  Effect.gen(function* () {
    const output = yield* readAgentOutput(
      [
        { runId: "owned", role: "assistant", text: '{"verdict":' },
        { runId: "owned", role: "assistant", text: '"accept"}' },
      ],
      "owned",
    );
    assert.strictEqual(output, '"accept"}');
    assert.strictEqual(yield* readAgentOutput([], "missing"), "");
    assert.deepEqual(
      yield* readAgentOutput([{ runId: "owned", role: "assistant", text: "[]" }], "owned"),
      [],
    );
  }),
);

it("tracks its initial message's exact run even when a newer run exists", () => {
  const runs = [
    { id: "owned", userMessageId: "action:message", status: "completed" },
    { id: "newer", userMessageId: "user-message", status: "running" },
  ];
  assert.equal(findActionRun(runs, "action")?.id, "owned");
  assert.isUndefined(findActionRun(runs, "other"));
});

it.effect("blocks legacy playbooks before launch and cancels an unlaunched action safely", () => {
  let launches = 0;
  const action: Action = {
    id: "action",
    runId: "run",
    phase: "agent",
    revision: 1,
    task: "agent",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 1800000,
    resultArtifactId: null,
    input: {
      personaId: "publisher",
      prompt: "Test unsupported authority",
      worktree: "/test",
      branch: "test",
      selectedEvidenceIds: [],
      selectedEvidenceHashes: [],
    },
  };
  const run: Run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 1,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: {},
    phase: "agent",
    revision: 1,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [action],
    artifacts: [],
    approvals: [],
    visits: { agent: 1 },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    const result = yield* adapter.reconcile(action, run, () => Effect.void);
    assert.equal(result.status, "blocked");
    yield* adapter.interrupt(action);
    assert.equal(launches, 0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(CommandReceiptStoreV2)({
          getByCommandId: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ThreadLaunchService)({
          launch: () => {
            launches++;
            return Effect.die("Unexpected launch");
          },
        }),
      ),
    ),
  );
});

it.effect("accepts a completed predecessor result before dispatching resumed work", () => {
  const assignment = testExecution.personas.scout;
  const input = {
    personaId: "scout",
    assignmentDigest: assignment.definitionDigest,
    prompt: "Investigate",
    worktree: "/test",
    branch: "test",
    selectedEvidenceIds: [],
    selectedEvidenceHashes: [],
  };
  const threadId = `thread:pb:${"a".repeat(64)}`;
  const predecessor: Action = {
    id: "old-action",
    runId: "run",
    phase: "context",
    revision: 1,
    task: "scout",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "blocked",
    deadline: 100,
    resultArtifactId: null,
    externalIdentity: `${threadId}/old-run`,
    input,
  };
  const firstReplacement: Action = {
    ...predecessor,
    id: "first-replacement",
    revision: 2,
    predecessorActionId: predecessor.id,
    externalIdentity: undefined,
  };
  const action: Action = {
    ...firstReplacement,
    id: "second-replacement",
    revision: 3,
    status: "pending",
    deadline: 2_000_000,
    predecessorActionId: firstReplacement.id,
    externalIdentity: undefined,
  };
  const run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 3,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: testExecution,
    phase: "context",
    revision: 3,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [predecessor, firstReplacement, action],
    artifacts: [],
    approvals: [],
    visits: { context: 1 },
  } satisfies Run;
  let identity = "";
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    const result = yield* adapter.reconcile(action, run, (value) =>
      Effect.sync(() => {
        identity = value;
      }),
    );
    assert.deepEqual(result, { status: "completed", output: { summary: "already done" } });
    assert.equal(identity, `${threadId}/first-replacement-run`);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
        Layer.mock(ThreadLaunchService)({ launch: () => Effect.die("Unexpected launch") }),
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () =>
            Effect.succeed({
              runs: [
                { id: "old-run", userMessageId: "old-action:message", status: "cancelled" },
                {
                  id: "first-replacement-run",
                  userMessageId: "first-replacement:message",
                  status: "completed",
                },
              ],
              messages: [
                {
                  id: "progress",
                  runId: "first-replacement-run",
                  role: "assistant",
                  text: "I have finished checking the evidence.",
                },
                {
                  id: "answer",
                  runId: "first-replacement-run",
                  role: "assistant",
                  text: '{"summary":"already done"}',
                },
                {
                  id: "other-run-answer",
                  runId: "unrelated-run",
                  role: "assistant",
                  text: '{"summary":"not this action"}',
                },
              ],
            } as never),
          sendToThread: () => Effect.die("Unexpected continuation"),
        }),
      ),
    ),
  );
});

it.effect("continues an interrupted predecessor in its saved conversation", () => {
  const assignment = testExecution.personas.scout;
  const input = {
    personaId: "scout",
    assignmentDigest: assignment.definitionDigest,
    prompt: "Investigate",
    worktree: "/test",
    branch: "test",
    selectedEvidenceIds: [],
    selectedEvidenceHashes: [],
  };
  const threadId = `thread:pb:${"b".repeat(64)}`;
  const predecessor = {
    id: "old-action",
    runId: "run",
    phase: "context",
    revision: 1,
    task: "scout",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "blocked",
    deadline: 100,
    resultArtifactId: null,
    externalIdentity: `${threadId}/old-run`,
    input,
  } satisfies Action;
  const action = {
    ...predecessor,
    id: "new-action",
    revision: 3,
    status: "pending",
    deadline: 2_000_000,
    predecessorActionId: predecessor.id,
    externalIdentity: undefined,
  } satisfies Action;
  const run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 3,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: testExecution,
    phase: "context",
    revision: 3,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [predecessor, action],
    artifacts: [],
    approvals: [],
    visits: { context: 1 },
  } satisfies Run;
  const sent: unknown[] = [];
  const launched: ThreadLaunchInput[] = [];
  let continued = false;
  let missing = false;
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    const result = yield* adapter.reconcile(action, run, () => Effect.void);
    assert.deepEqual(result, { status: "completed", output: { summary: "resumed" } });
    assert.lengthOf(sent, 1);
    assert.include(String((sent[0] as { text: string }).text), "Continue where you left off");
    missing = true;
    yield* adapter
      .reconcile({ ...action, id: "fallback-action" }, run, () => Effect.void)
      .pipe(Effect.flip);
    assert.lengthOf(launched, 1);
    assert.equal(launched[0]!.initialMessage?.text, "Investigate\n");
    assert.notEqual(String(launched[0]!.threadId), threadId);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
        Layer.mock(ThreadLaunchService)({
          launch: (request) => {
            launched.push(request);
            return Effect.fail(
              new ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId: request.projectId,
                cause: "Captured fallback",
              }),
            );
          },
        }),
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () =>
            missing
              ? Effect.fail("missing" as never)
              : Effect.succeed(
                  (continued
                    ? {
                        runs: [
                          {
                            id: "old-run",
                            userMessageId: "old-action:message",
                            status: "cancelled",
                          },
                          {
                            id: "new-run",
                            userMessageId: "new-action:message",
                            status: "completed",
                          },
                        ],
                        messages: [
                          {
                            id: "answer",
                            runId: "new-run",
                            role: "assistant",
                            text: '{"summary":"resumed"}',
                          },
                        ],
                      }
                    : {
                        runs: [
                          {
                            id: "old-run",
                            userMessageId: "old-action:message",
                            status: "cancelled",
                          },
                        ],
                        messages: [],
                      }) as never,
                ),
          sendToThread: (request) =>
            Effect.sync(() => {
              sent.push(request);
              continued = true;
              return {} as never;
            }),
        }),
      ),
    ),
  );
});

it.effect("reuses the exact saved assignment for retries and output corrections", () => {
  const captured: ThreadLaunchInput[] = [];
  const assignment = testExecution.personas.scout;
  const input = {
    personaId: "scout",
    assignmentDigest: assignment.definitionDigest,
    prompt: "Test",
    worktree: "/test",
    branch: "test",
    selectedEvidenceIds: [],
    selectedEvidenceHashes: [],
  };
  const action: Action = {
    id: "action",
    runId: "run",
    phase: "context",
    revision: 1,
    task: "scout",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 10000,
    resultArtifactId: null,
    input,
  };
  const run: Run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 3,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: testExecution,
    phase: "context",
    revision: 1,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [action],
    artifacts: [],
    approvals: [],
    visits: { context: 1 },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    for (const current of [
      action,
      action,
      {
        ...action,
        id: "correction",
        input: { original: input, correction: "Return valid JSON", output: "bad" },
      },
    ]) {
      yield* adapter.reconcile(current, run, () => Effect.void).pipe(Effect.flip);
    }
    assert.lengthOf(captured, 3);
    for (const launch of captured) {
      assert.deepEqual(launch.preparedPersonaAssignment, assignment);
      assert.deepEqual(launch.modelSelection, assignment.resolvedModelSelection);
      assert.isUndefined(launch.agentPersona);
    }
    assert.include(captured[2]!.initialMessage!.text, "Return valid JSON");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
        Layer.mock(ThreadLaunchService)({
          launch: (launch) => {
            captured.push(launch);
            // Stop at the thread service boundary; its real guards are tested by the launch integration.
            return Effect.fail(
              new ThreadLaunchError({
                operation: "create-thread",
                commandId: launch.commandId,
                projectId: launch.projectId,
                cause: "Captured launch",
              }),
            );
          },
        }),
      ),
    ),
  );
});

it.effect("starts a separate turn on an idle named agent conversation", () => {
  const sent: unknown[] = [];
  const assignment = testExecution.personas.scout;
  const action: Action = {
    id: "second-action",
    runId: "run",
    phase: "repair",
    revision: 2,
    task: "fix",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 10000,
    resultArtifactId: null,
    input: {
      personaId: "scout",
      assignmentKey: "scout",
      authorityPolicy: "read-only",
      assignmentDigest: assignment.definitionDigest,
      sharedInstance: "implementer",
      prompt: "Continue",
      worktree: "/test",
      branch: "test",
      selectedEvidenceIds: [],
      selectedEvidenceHashes: [],
    },
  };
  const run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 3,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: testExecution,
    phase: "repair",
    revision: 2,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [action],
    artifacts: [],
    approvals: [],
    visits: { repair: 1 },
  } satisfies Run;
  const first = {
    runs: [{ id: "first-run", userMessageId: "pb:first:message", status: "completed" }],
    messages: [],
  };
  const completed = {
    runs: [
      ...first.runs,
      { id: "second-run", userMessageId: "second-action:message", status: "completed" },
    ],
    messages: [
      { id: "progress", runId: "second-run", role: "assistant", text: "Checking the plan." },
      {
        id: "answer",
        runId: "second-run",
        role: "assistant",
        text: 'Wrote the critique.\n\n```json\n{"summary":"done"}\n```',
      },
    ],
  };
  let reads = 0;
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    const result = yield* adapter.reconcile(action, run, () => Effect.void);
    assert.deepEqual(result, { status: "completed", output: { summary: "done" } });
    assert.lengthOf(sent, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
        Layer.mock(ThreadLaunchService)({ launch: () => Effect.die("Unexpected new thread") }),
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed((reads++ === 0 ? first : completed) as never),
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
});
