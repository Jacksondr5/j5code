import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import type { ThreadLaunchInput } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { AgentCrewInstanceService } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { CrewProposalService } from "./CrewProposalService.ts";
import { CrewStopService } from "./CrewStopService.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2AHomeRegistrar, participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger } from "./LedgerService.ts";
import { ParticipantPlacementService, PlacementStorageError } from "./PlacementService.ts";
import { A2ASendService } from "./SendService.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { SquadronJoinService } from "./SquadronJoinService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import { ParticipantId, SquadronId, type ParticipantDirectoryRow } from "./contracts.ts";
import { J5ToolkitHandlersLive } from "./mcp/handlers.ts";
import { J5SpawnAgentInput, J5Toolkit } from "./mcp/tools.ts";
import {
  SpawnWorkspaceChoice,
  resolveSpawnWorkspace,
  type SpawnCheckout,
} from "./spawnWorkspace.ts";
import { type FakeCheckout, fakeSpawnWorkspaceLayer } from "./test-support/spawnWorkspaceFakes.ts";

const checkout = (
  overrides: Partial<Extract<SpawnCheckout, { readonly readable: true }>> = {},
): SpawnCheckout => ({
  readable: true,
  worktrees: [{ path: "/repo-worktrees/feature", branch: "fix/login" }],
  localBranchNames: ["j5/main", "taken"],
  missingBaseRefs: [],
  ...overrides,
});

it("resolves each explicit choice; only shared asks nothing of git", () => {
  const resolve = (...args: Parameters<typeof resolveSpawnWorkspace>) =>
    Result.getOrThrow(resolveSpawnWorkspace(...args));
  const unreadable: SpawnCheckout = { readable: false, problem: "git is not installed" };
  assert.deepStrictEqual(resolve(unreadable, { type: "shared" }), { type: "shared" });
  assert.deepStrictEqual(
    resolve(checkout(), {
      type: "worktree",
      baseRef: "release",
      branch: "fix/new",
      startFromOrigin: true,
    }),
    { type: "worktree", baseRef: "release", branch: "fix/new", startFromOrigin: true },
  );
  assert.deepStrictEqual(resolve(checkout(), { type: "worktree", baseRef: "j5/main" }), {
    type: "worktree",
    baseRef: "j5/main",
    startFromOrigin: false,
  });
  // An existing worktree resolves to git's own path and the branch checked out there.
  assert.deepStrictEqual(
    resolve(checkout(), { type: "existing_worktree", worktreePath: "/repo-worktrees/feature/" }),
    { type: "existing_worktree", worktreePath: "/repo-worktrees/feature", branch: "fix/login" },
  );
});

it("refuses a choice git can't give, with the next step", () => {
  const refusal = (...args: Parameters<typeof resolveSpawnWorkspace>) => {
    const result = resolveSpawnWorkspace(...args);
    assert.isTrue(Result.isFailure(result));
    return Result.isFailure(result) ? result.failure : undefined;
  };
  // An unreadable repository refuses rather than falling back to the caller's checkout.
  const unreadable = refusal(
    { readable: false, problem: "git is not installed" },
    { type: "worktree", baseRef: "j5/main" },
  );
  assert.include(unreadable?.detail, "can't be read (git is not installed)");
  assert.include(unreadable?.nextStep, '{"type":"shared"}');
  assert.include(
    refusal(checkout(), { type: "worktree", baseRef: "j5/main", branch: "taken" })?.detail,
    "Branch 'taken' already exists",
  );
  const unknown = refusal(checkout(), { type: "existing_worktree", worktreePath: "/repo" });
  assert.include(unknown?.detail, "isn't one of this project's worktrees");
  assert.include(unknown?.detail, "/repo-worktrees/feature");
  assert.include(
    refusal(checkout({ worktrees: [] }), {
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/feature",
    })?.detail,
    "The project has none",
  );
});

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:spawn-workspace"),
  threadId: ThreadId.make("thread:j5:spawn-workspace-caller"),
  providerSessionId: "provider-session:j5:spawn-workspace",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
const squadronId = SquadronId.make("squadron:j5:spawn-workspace");
const callerParticipantId = ParticipantId.make("agent:j5:spawn-workspace-caller");
const childParticipantId = ParticipantId.make("agent:j5:spawn-workspace-child");
const projectId = ProjectId.make("project:j5:spawn-workspace");
const createdAt = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");

/** The caller works on the project's root checkout, which records no branch or worktree. */
const callerThread = (threadId: ThreadId) =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Caller",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  }) as unknown as OrchestrationV2ThreadProjection;

const spawnHarness = (input: {
  readonly checkout: FakeCheckout;
  /** Git as an agent's shell leaves it, served through upstream-style cached refs. */
  readonly liveCheckout?: Ref.Ref<FakeCheckout>;
  /** The durable command log; pass one from an earlier harness to model a restart. */
  readonly commands?: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
  /** Runs inside each thread.create before it lands, so a test can hold a start open. */
  readonly beforeCreate?: Effect.Effect<void>;
  /**
   * What ThreadLaunch's preparation comes to once the launch starts: the worktree is bound
   * (default), the preparation fails, or it never settles.
   */
  readonly preparation?: "bound" | "failed" | "never";
}) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands = input.commands ?? (yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]));
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchInput>>([]);
    const failFacts = yield* Ref.make(false);
    const launched = yield* Ref.make(false);
    const archived = yield* Ref.make(false);
    const checkoutOutcome = input.preparation ?? "bound";
    /** The spawned thread as upstream's projection shows it: bound, failed, or still preparing. */
    const childThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const base = callerThread(threadId);
        const started = yield* Ref.get(launched);
        const archivedAt = (yield* Ref.get(archived)) ? createdAt : null;
        return {
          ...base,
          thread: {
            ...base.thread,
            archivedAt,
            deletedAt: null,
            worktreePath: started && checkoutOutcome === "bound" ? "/repo-worktrees/spawned" : null,
          },
          runs:
            started && checkoutOutcome === "failed" ? [{ id: "run:prep", status: "failed" }] : [],
          turnItems:
            started && checkoutOutcome === "failed"
              ? [
                  {
                    runId: "run:prep",
                    type: "error",
                    status: "failed",
                    failure: {
                      class: "validation_error",
                      message: "Workspace preparation failed: no-such-ref",
                      code: null,
                      retryable: false,
                    },
                  },
                ]
              : [],
        } as unknown as OrchestrationV2ThreadProjection;
      });
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () => Effect.succeed({ squadronId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readSquadron: () =>
          Effect.succeed({
            id: squadronId,
            name: "Workspace",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({
        recordFacts: (facts) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failFacts))
              return yield* new PlacementStorageError({
                operation: "record spawn facts",
                cause: new Error("injected"),
              });
            yield* Ref.update(log, (items) => [...items, "facts"]);
            return {
              home: { squadronId, participantId: childParticipantId },
              placement: {
                squadronId,
                participantId: childParticipantId,
                provenance: facts.provenance,
                placementParentId: callerParticipantId,
                createdEventSeq: 1,
                updatedEventSeq: 1,
              },
            };
          }),
      }),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          threadId === invocation.threadId
            ? Effect.succeed(callerThread(threadId))
            : childThread(threadId),
        getThreadShell: () => Effect.succeed(null),
        getThreadEventSequence: () => Effect.succeed(0),
        // Nothing the fake launch does is an event; the preparation's outcome is read from the
        // projection, and a preparation that never settles has no events at all.
        streamStoredEventsFrom: () => Stream.never,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "thread.archive") yield* Ref.set(archived, true);
            if (command.type === "thread.create" && input.beforeCreate) yield* input.beforeCreate;
            yield* Ref.update(commands, (items) => [...items, command]);
            yield* Ref.update(log, (items) => [...items, command.type]);
            return { events: [], effects: [] } as never;
          }),
      }),
      Layer.mock(OrchestratorMcpService)({
        capabilities: () =>
          Effect.succeed({
            parentThreadId: invocation.threadId,
            inheritedProviderInstanceId: invocation.providerInstanceId,
            inheritedModel: "gpt-5.6-sol",
            runtimeMode: "full-access",
            interactionMode: "default",
            providers: [
              {
                providerInstanceId: ProviderInstanceId.make("codex"),
                driverKind: ProviderDriverKind.make("codex"),
                displayName: "Codex",
                models: [
                  {
                    id: "gpt-5.6-sol",
                    label: "GPT-5.6 Sol",
                    options: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select" as const,
                        options: [{ id: "high", label: "High" }],
                      },
                    ],
                  },
                ],
                canRunChildTask: true,
                canRunCrossProviderChildTask: true,
                constraints: [],
              },
            ],
            features: {
              appOwnedSubagents: true,
              asyncPolling: true,
              cancellation: true,
              batchThreadCreation: true,
              threadManagement: true,
              incrementalThreadRead: true,
              scheduledTasks: true,
              maxBatchThreads: 8,
            },
          }),
      }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),
      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        fakeSpawnWorkspaceLayer({
          checkout: input.checkout,
          ...(input.liveCheckout === undefined ? {} : { liveCheckout: input.liveCheckout }),
          launches,
          launch: () =>
            Ref.update(log, (items) => [...items, "launch"]).pipe(
              Effect.andThen(Ref.set(launched, true)),
            ),
          // An accepted create leaves its receipt, as the orchestrator's does.
          accepted: Ref.get(commands).pipe(
            Effect.map((all) =>
              all.flatMap((command) =>
                command.type === "thread.create" ? [command.commandId] : [],
              ),
            ),
          ),
        }),
      ),
      Layer.provideMerge(dependencies),
    );
    const call = (args: J5SpawnAgentInput) =>
      Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        return yield* toolkit
          .handle("spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      });
    return { layer, call, log, commands, launches, failFacts, archived };
  });

const spawnArgs = {
  brief: "Fix the login bug and report back.",
  provider: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  reasoning: "high",
  workspace: { type: "worktree", base_ref: "j5/main" },
} satisfies J5SpawnAgentInput;

it.effect("spawns into a new worktree from base_ref, keeping home, placement, and result", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({ ...spawnArgs, client_request_id: "new-worktree" });
      assert.isFalse(spawned.isFailure);
      const result = spawned.result as { readonly thread_id: ThreadId };
      assert.deepStrictEqual(spawned.result, {
        participant_id: childParticipantId,
        thread_id: result.thread_id,
        squadron_id: squadronId,
        placement: {
          placement_parent_id: callerParticipantId,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: callerParticipantId,
            source: "j5_spawn",
          },
        },
      });
      // The peer is registered only once its worktree is bound, after ThreadLaunch took the brief.
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "launch", "facts"]);
      const [create] = yield* Ref.get(commands);
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.isNull(create.branch);
        assert.isNull(create.worktreePath);
        assert.include(create.commandId, "spawn-create-worktree");
      }
      const [launch] = yield* Ref.get(launches);
      assert.equal(launch?.threadId, result.thread_id);
      assert.isTrue(launch?.reuseExistingThread);
      assert.equal(launch?.squadronId, squadronId);
      assert.equal(launch?.projectId, projectId);
      assert.deepStrictEqual(launch?.workspaceStrategy, {
        type: "worktree",
        baseRef: "j5/main",
        startFromOrigin: false,
      });
      assert.include(
        launch?.initialMessage?.text,
        `participant_id: ${participantIdForThread(result.thread_id)}`,
      );
      assert.include(launch?.initialMessage?.text, spawnArgs.brief);
      assert.include(String(launch?.initialMessage?.messageId), "spawn-brief");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a checkout that fails retires the peer and returns one ordinary error", () =>
  Effect.gen(function* () {
    const { layer, call, log, archived } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      preparation: "failed",
    });
    yield* Effect.gen(function* () {
      const failed = yield* call({ ...spawnArgs, client_request_id: "unready" });
      assert.isTrue(failed.isFailure);
      const message = (failed.result as { readonly message: string }).message;
      assert.include(message, "no-such-ref");
      assert.include(message, "nothing is left registered");
      // The thread is archived and never registered: no home, no placement.
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "launch", "thread.archive"]);
      assert.isTrue(yield* Ref.get(archived));
      // The same request replays the same refusal rather than registering the peer.
      const replay = yield* call({ ...spawnArgs, client_request_id: "unready" });
      assert.isTrue(replay.isFailure);
      assert.notInclude(yield* Ref.get(log), "facts");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a checkout still running after 60 seconds retires the peer", () =>
  Effect.gen(function* () {
    const { layer, call, log, archived } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      preparation: "never",
    });
    yield* Effect.gen(function* () {
      const spawning = yield* call({ ...spawnArgs, client_request_id: "slow" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(spawning.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(spawning);
      assert.isTrue(result.isFailure);
      assert.include(
        (result.result as { readonly message: string }).message,
        "timed out waiting 60s for the checkout",
      );
      assert.isTrue(yield* Ref.get(archived));
      assert.notInclude(yield* Ref.get(log), "facts");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("an explicit shared workspace keeps the caller's checkout and starts the brief", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "explicit-shared",
      });
      assert.isFalse(spawned.isFailure);
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "message.dispatch"]);
      const [create, brief] = yield* Ref.get(commands);
      if (create?.type === "thread.create") assert.notInclude(create.commandId, "worktree");
      if (brief?.type === "message.dispatch")
        assert.deepStrictEqual(brief.dispatchMode, { type: "start_immediately" });
      assert.lengthOf(yield* Ref.get(launches), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("binds a client_request_id to its first workspace type, across a restart", () =>
  Effect.gen(function* () {
    const first = yield* spawnHarness({ checkout: { isRepo: true, refName: "j5/main" } });
    yield* Effect.gen(function* () {
      // The worktree is made and bound, then the spawn stops before its home is recorded.
      yield* Ref.set(first.failFacts, true);
      const halfDone = yield* first.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "j5/main" },
        client_request_id: "bound",
      });
      assert.isTrue(halfDone.isFailure);
      assert.lengthOf(yield* Ref.get(first.commands), 1);
    }).pipe(Effect.provide(first.layer));

    // A fresh server: a new permit, the same durable receipts.
    const restarted = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      commands: first.commands,
    });
    yield* Effect.gen(function* () {
      const switched = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "shared" },
        client_request_id: "bound",
      });
      assert.isTrue(switched.isFailure);
      assert.include(
        (switched.result as { readonly message: string }).message,
        'already bound to workspace {"type":"worktree"}',
      );
      assert.lengthOf(yield* Ref.get(restarted.commands), 1);

      // The first attempt already launched; the retry's launch is the same command, which
      // ThreadLaunch replays, so a different base here changes nothing.
      const resumed = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "release" },
        client_request_id: "bound",
      });
      assert.isFalse(resumed.isFailure);
      const [original, replay] = yield* Ref.get(restarted.commands);
      assert.equal(replay?.commandId, original?.commandId);
      assert.lengthOf(yield* Ref.get(restarted.launches), 1);
    }).pipe(Effect.provide(restarted.layer));
  }),
);

it.effect("a second start on one key while the first is in flight is refused, not queued", () =>
  Effect.gen(function* () {
    const createsEntered = yield* Ref.make(0);
    const createEntered = yield* Deferred.make<void>();
    const secondCreateEntered = yield* Deferred.make<void>();
    const releaseCreate = yield* Deferred.make<void>();
    const harness = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
      // Every create waits for the release, and says whether it is the first or a second one.
      beforeCreate: Ref.updateAndGet(createsEntered, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          Deferred.succeed(count === 1 ? createEntered : secondCreateEntered, undefined),
        ),
        Effect.andThen(Deferred.await(releaseCreate)),
      ),
    });
    yield* Effect.gen(function* () {
      const winner = yield* harness
        .call({
          ...spawnArgs,
          workspace: { type: "worktree", base_ref: "j5/main" },
          client_request_id: "raced",
        })
        .pipe(Effect.forkChild);
      // The first start is in flight, stopped inside its create.
      yield* Deferred.await(createEntered);
      const loser = yield* harness
        .call({ ...spawnArgs, workspace: { type: "shared" }, client_request_id: "raced" })
        .pipe(Effect.forkChild);
      // The second start returns while the first still holds its create; without the guard it
      // would reach a create of its own instead, which ends this race the other way.
      const second = yield* Effect.raceFirst(
        Fiber.join(loser).pipe(Effect.map((result) => ({ kind: "returned" as const, result }))),
        Deferred.await(secondCreateEntered).pipe(Effect.as({ kind: "second create" as const })),
      );
      yield* Deferred.succeed(releaseCreate, undefined);
      assert.equal(second.kind, "returned");
      if (second.kind === "returned") {
        assert.isTrue(second.result.isFailure);
        assert.include(
          (second.result.result as { readonly message: string }).message,
          "already in progress",
        );
      }

      assert.isFalse((yield* Fiber.join(winner)).isFailure);
      const commands = yield* Ref.get(harness.commands);
      const creates = commands.filter((command) => command.type === "thread.create");
      assert.lengthOf(creates, 1);
      // The one thread is the winner's: unbound until ThreadLaunch prepares its worktree.
      const [create] = creates;
      if (create?.type === "thread.create") {
        assert.include(create.commandId, "spawn-create-worktree");
        assert.isNull(create.worktreePath);
      }
      assert.lengthOf(yield* Ref.get(harness.launches), 1);
      assert.lengthOf(
        commands.filter((command) => command.type === "message.dispatch"),
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it("refuses a git ref git would read as an option, in both the MCP and stored forms", () => {
  const mcp = Schema.decodeUnknownExit(J5SpawnAgentInput);
  const stored = Schema.decodeUnknownExit(SpawnWorkspaceChoice);
  for (const ref of ["--force", "-b", "main --orphan", "fix\nlogin", "\tmain"]) {
    for (const field of ["base_ref", "branch"] as const)
      assert.isTrue(
        Exit.isFailure(mcp({ ...spawnArgs, workspace: { type: "worktree", [field]: ref } })),
        `${field} ${JSON.stringify(ref)}`,
      );
    assert.isTrue(Exit.isFailure(stored({ type: "worktree", baseRef: ref })));
    // The person's card edits use the unconstrained client contract; the resolver refuses too.
    assert.isTrue(
      Result.isFailure(resolveSpawnWorkspace(checkout(), { type: "worktree", baseRef: ref })),
    );
  }
  for (const ref of ["j5/main", "release-1.2", "feature/a-b"])
    assert.isTrue(
      Exit.isSuccess(
        mcp({ ...spawnArgs, workspace: { type: "worktree", base_ref: ref, branch: ref } }),
      ),
    );
});

it.effect("refuses a base ref git can't resolve before anything is created", () =>
  Effect.gen(function* () {
    const { layer, call, commands, launches } = yield* spawnHarness({
      checkout: {
        isRepo: true,
        refName: "j5/main",
        missingRefs: ["no-such-ref", "only-on-origin"],
      },
    });
    yield* Effect.gen(function* () {
      const refused = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "no-such-ref" },
        client_request_id: "missing-base",
      });
      assert.isTrue(refused.isFailure);
      assert.include(
        (refused.result as { readonly message: string }).message,
        "Base ref 'no-such-ref' doesn't resolve to a commit",
      );
      assert.lengthOf(yield* Ref.get(commands), 0);
      // From origin, its fetched copy is enough; locally it isn't.
      const local = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "only-on-origin" },
        client_request_id: "remote-base-local",
      });
      assert.isTrue(local.isFailure);
      const fromOrigin = yield* call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "only-on-origin", start_from_origin: true },
        client_request_id: "remote-base-origin",
      });
      assert.isFalse(fromOrigin.isFailure);
      assert.lengthOf(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }),
);

const decodeSpawnInput = Schema.decodeUnknownExit(J5SpawnAgentInput);

it("requires a workspace on every spawn", () => {
  const { workspace: _workspace, ...withoutWorkspace } = spawnArgs;
  assert.isTrue(Exit.isFailure(decodeSpawnInput(withoutWorkspace)));
  assert.isTrue(
    Exit.isFailure(
      decodeSpawnInput({
        ...spawnArgs,
        workspace: { type: "worktree" },
      }),
    ),
  );
});

it.effect("spawns into an existing worktree on its branch, with no preparation", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: {
        isRepo: true,
        refName: "j5/main",
        worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
      },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "existing",
      });
      assert.isFalse(spawned.isFailure);
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "message.dispatch"]);
      const [create] = yield* Ref.get(commands);
      if (create?.type === "thread.create") {
        assert.equal(create.worktreePath, "/repo-worktrees/builder");
        assert.equal(create.branch, "fix/login");
        assert.include(create.commandId, "spawn-create-existing");
      }
      assert.lengthOf(yield* Ref.get(launches), 0);
      // The key is now bound to the existing worktree; a new-worktree retry is refused.
      const switched = yield* call({ ...spawnArgs, client_request_id: "existing" });
      assert.isTrue(switched.isFailure);
      assert.include(
        (switched.result as { readonly message: string }).message,
        'already bound to workspace {"type":"existing_worktree"}',
      );
      const elsewhere = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/tmp/not-a-worktree" },
        client_request_id: "elsewhere",
      });
      assert.isTrue(elsewhere.isFailure);
      assert.include(
        (elsewhere.result as { readonly message: string }).message,
        "Its worktrees: /repo-worktrees/builder",
      );
      assert.lengthOf(yield* Ref.get(commands), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reads git fresh for each spawn that binds a worktree", () =>
  Effect.gen(function* () {
    const live = yield* Ref.make<FakeCheckout>({
      isRepo: true,
      refName: "j5/main",
      worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/login" }],
    });
    const { layer, call, commands } = yield* spawnHarness({
      checkout: { isRepo: false, refName: null },
      liveCheckout: live,
    });
    yield* Effect.gen(function* () {
      const first = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "before",
      });
      assert.isFalse(first.isFailure);
      // From its own shell, the builder switches branch; upstream's ref cache doesn't hear it.
      yield* Ref.set(live, {
        isRepo: true,
        refName: "j5/main",
        worktrees: [{ path: "/repo-worktrees/builder", branch: "fix/signup" }],
      });
      const second = yield* call({
        ...spawnArgs,
        workspace: { type: "existing_worktree", worktree_path: "/repo-worktrees/builder" },
        client_request_id: "after",
      });
      assert.isFalse(second.isFailure);
      const branches = (yield* Ref.get(commands)).flatMap((command) =>
        command.type === "thread.create" ? [command.branch] : [],
      );
      assert.deepStrictEqual(branches, ["fix/login", "fix/signup"]);
    }).pipe(Effect.provide(layer));
  }),
);
