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
import { A2AHomeRegistrar } from "./HomeRegistrar.ts";
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

const checkout = (overrides: Partial<SpawnCheckout> = {}): SpawnCheckout => ({
  inWorktree: false,
  isRepo: true,
  refName: "j5/main",
  localBranchNames: ["j5/main", "taken"],
  missingBaseRefs: [],
  problem: null,
  ...overrides,
});

it("defaults spawns to a worktree and seats to their Captain's worktree, where git allows", () => {
  const resolve = (...args: Parameters<typeof resolveSpawnWorkspace>) =>
    Result.getOrThrow(resolveSpawnWorkspace(...args));
  const fresh = { type: "worktree", baseRef: "j5/main", startFromOrigin: false } as const;
  // Root-checkout threads record no branch; the live checkout decides.
  assert.deepStrictEqual(resolve(checkout(), undefined, "spawn"), fresh);
  assert.deepStrictEqual(resolve(checkout(), undefined, "seat"), fresh);
  assert.deepStrictEqual(resolve(checkout({ inWorktree: true }), undefined, "spawn"), fresh);
  assert.deepStrictEqual(resolve(checkout({ inWorktree: true }), undefined, "seat"), {
    type: "shared",
  });
  for (const door of ["spawn", "seat"] as const) {
    assert.deepStrictEqual(resolve(checkout({ isRepo: false, refName: null }), undefined, door), {
      type: "shared",
    });
    assert.deepStrictEqual(resolve(checkout({ refName: null }), undefined, door), {
      type: "shared",
    });
  }
  assert.deepStrictEqual(resolve(checkout(), { type: "shared" }, "spawn"), { type: "shared" });
  assert.deepStrictEqual(
    resolve(
      checkout({ inWorktree: true }),
      { type: "worktree", baseRef: "release", branch: "fix/login", startFromOrigin: true },
      "seat",
    ),
    { type: "worktree", baseRef: "release", branch: "fix/login", startFromOrigin: true },
  );
});

it("refuses an explicit worktree git cannot make, with the next step", () => {
  const refusal = (...args: Parameters<typeof resolveSpawnWorkspace>) => {
    const result = resolveSpawnWorkspace(...args);
    assert.isTrue(Result.isFailure(result));
    return Result.isFailure(result) ? result.failure : undefined;
  };
  const notRepo = refusal(
    checkout({ isRepo: false, refName: null, problem: "git is not installed" }),
    { type: "worktree" },
    "spawn",
  );
  assert.include(notRepo?.detail, "not a git repository (git is not installed)");
  assert.include(notRepo?.nextStep, '{"type":"shared"}');
  assert.include(
    refusal(checkout({ refName: null }), { type: "worktree" }, "spawn")?.nextStep,
    "workspace.base_ref",
  );
  assert.isTrue(
    Result.isSuccess(
      resolveSpawnWorkspace(
        checkout({ refName: null }),
        { type: "worktree", baseRef: "v1" },
        "seat",
      ),
    ),
  );
  assert.include(
    refusal(checkout(), { type: "worktree", branch: "taken" }, "spawn")?.detail,
    "Branch 'taken' already exists",
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
  /** The durable command log; pass one from an earlier harness to model a restart. */
  readonly commands?: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
  /** Runs inside each thread.create before it lands, so a test can hold a start open. */
  readonly beforeCreate?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands = input.commands ?? (yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]));
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchInput>>([]);
    const failFacts = yield* Ref.make(false);
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
        getThreadProjection: (threadId) => Effect.succeed(callerThread(threadId)),
        getThreadShell: () => Effect.succeed(null),
        dispatch: (command) =>
          Effect.gen(function* () {
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
          launches,
          launch: () => Ref.update(log, (items) => [...items, "launch"]),
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
    return { layer, call, log, commands, launches, failFacts };
  });

const spawnArgs = {
  brief: "Fix the login bug and report back.",
  provider: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  reasoning: "high",
} satisfies J5SpawnAgentInput;

it.effect("spawns into a fresh worktree by default, keeping home, placement, and result", () =>
  Effect.gen(function* () {
    const { layer, call, log, commands, launches } = yield* spawnHarness({
      checkout: { isRepo: true, refName: "j5/main" },
    });
    yield* Effect.gen(function* () {
      const spawned = yield* call({ ...spawnArgs, client_request_id: "default-worktree" });
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
      // Home and placement are committed before ThreadLaunch claims the thread for its brief.
      assert.deepStrictEqual(yield* Ref.get(log), ["thread.create", "facts", "launch"]);
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
      assert.include(launch?.initialMessage?.text, `participant_id: ${childParticipantId}`);
      assert.include(launch?.initialMessage?.text, spawnArgs.brief);
      assert.include(String(launch?.initialMessage?.messageId), "spawn-brief");
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
      // The worktree create is accepted, then the spawn stops before its home is recorded.
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
        "already bound to a worktree workspace",
      );
      assert.lengthOf(yield* Ref.get(restarted.commands), 1);

      // Options are not bound: nothing was provisioned yet, so the retry's base takes effect.
      const resumed = yield* restarted.call({
        ...spawnArgs,
        workspace: { type: "worktree", base_ref: "release" },
        client_request_id: "bound",
      });
      assert.isFalse(resumed.isFailure);
      const [original, replay] = yield* Ref.get(restarted.commands);
      assert.equal(replay?.commandId, original?.commandId);
      const launches = yield* Ref.get(restarted.launches);
      assert.lengthOf(launches, 1);
      assert.equal(
        launches[0]?.workspaceStrategy.type === "worktree" && launches[0].workspaceStrategy.baseRef,
        "release",
      );
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
        .call({ ...spawnArgs, workspace: { type: "worktree" }, client_request_id: "raced" })
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
      Result.isFailure(
        resolveSpawnWorkspace(checkout(), { type: "worktree", baseRef: ref }, "seat"),
      ),
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
