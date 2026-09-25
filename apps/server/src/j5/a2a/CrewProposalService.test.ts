import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../../config.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
  type AgentCrewInstance,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalStoreLayer,
} from "./AgentCrewProposalService.ts";
import { CrewLaunchReporter } from "./CrewLaunchReporter.ts";
import {
  CrewLaunchOperationError,
  CrewLaunchService,
  type CrewCaptain,
  type ResolvedCrewLaunchSeat,
} from "./CrewLaunchService.ts";
import {
  CREW_SEAT_CAP,
  CrewProposalService,
  layer as crewProposalLayer,
  type ResolveCrewProposalInput,
} from "./CrewProposalService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:crew-proposal");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:j5:a2a:thread:captain");
const createdAt = DateTime.makeUnsafe("2026-09-09T16:00:00.000Z");
const thread = (id: ThreadId): OrchestrationV2AppThread =>
  ({
    id,
    projectId: ProjectId.make("project:crew-proposal"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
    archivedAt: null,
  }) as unknown as OrchestrationV2AppThread;
const captain: CrewCaptain = {
  squadronId,
  squadronName: "Proposal Squadron",
  participantId: captainId,
  thread: thread(captainThread),
};

const launchFailure = (cause: unknown) =>
  new CrewLaunchOperationError({ phase: "test launcher", seatName: null, createdSeats: [], cause });

/**
 * The launcher is exercised by its own test; here it records members so the gate can be proven.
 * Like the real one it records the Crew before any seat spawns and reports it through
 * `onRecorded`; a display name of "Boom" fails before recording, "Boom after record" fails after.
 */
const fakeLauncher = (crews: AgentCrewInstanceService["Service"]) =>
  Layer.mock(CrewLaunchService)({
    resolveSeats: (captain, seats) =>
      Effect.succeed(
        seats.map(
          (seat) =>
            ({
              seat,
              assignment: null,
              modelSelection: seat.modelSelection ?? captain.thread.modelSelection,
              runtimeMode: seat.runtimeMode ?? captain.thread.runtimeMode,
              outputArtifact: null,
              agentDisplayName: seat.agentId ?? "custom",
              runtime: {
                seat: seat.name,
                provider: "Codex",
                harness: "Codex",
                model: (seat.modelSelection ?? captain.thread.modelSelection).model,
                reasoning: "High",
                access: "Full access",
                modelSelection: seat.modelSelection ?? captain.thread.modelSelection,
                runtimeMode: seat.runtimeMode ?? captain.thread.runtimeMode,
              },
            }) satisfies ResolvedCrewLaunchSeat,
        ),
      ),
    launch: (input) =>
      input.displayName === "Boom"
        ? Effect.fail(launchFailure(new Error("provider unavailable")))
        : crews
            .record({
              id: `crew:${input.requestKey}`,
              squadronId: input.captain.squadronId,
              captainParticipantId: input.captain.participantId,
              captainThreadId: input.captain.thread.id,
              displayName: input.displayName,
              brief: input.brief,
              createdAt: DateTime.formatIso(createdAt),
              members: input.seats.map((seat) => ({
                seatName: seat.name,
                agentId: seat.agentId,
                participantId: ParticipantId.make(`agent:j5:a2a:thread:${seat.name}`),
                threadId: ThreadId.make(`thread:${seat.name}`),
                reason: seat.reason,
              })),
            })
            .pipe(
              Effect.mapError(launchFailure),
              Effect.tap((instance) => input.onRecorded?.(instance) ?? Effect.void),
              // Launch once: a seat that fails to spawn is an outcome, not an error. "Boom after
              // record" loses its second seat, which the real launcher drops from the record.
              Effect.flatMap((instance) =>
                input.displayName === "Boom after record"
                  ? crews.removeMembers(instance.id, [input.seats[1]!.name]).pipe(
                      Effect.mapError(launchFailure),
                      Effect.andThen(crews.read(instance.id).pipe(Effect.mapError(launchFailure))),
                      Effect.map((current) => ({
                        instance: current!,
                        seats: input.seats.map((seat, index) =>
                          index === 1
                            ? {
                                seatName: seat.name,
                                kind: "not_created" as const,
                                detail: "second seat failed to spawn",
                              }
                            : { seatName: seat.name, kind: "created" as const },
                        ),
                      })),
                    )
                  : Effect.succeed({
                      instance,
                      seats: input.seats.map((seat) => ({
                        seatName: seat.name,
                        kind: "created" as const,
                      })),
                    }),
              ),
            ),
    // Additions reserve rows under the real deterministic ids before spawning, like the launcher,
    // then resolve the proposal through `onReserved` before any seat spawns.
    addSeats: (input) =>
      Effect.gen(function* () {
        const outcome = yield* crews.addMembers(
          input.instance.id,
          input.seats.map((seat) => {
            const threadId = spawnThreadId({
              providerSessionId: input.providerSessionId,
              requestKey: crewSeatRequestKey(input.requestKey, seat.name),
            });
            return {
              seatName: seat.name,
              agentId: seat.agentId,
              participantId: participantIdForThread(threadId),
              threadId,
              reason: seat.reason,
            };
          }),
        );
        if (outcome.instance === null) return yield* launchFailure(new Error("crew is gone"));
        if (input.onReserved !== undefined)
          yield* input.onReserved(outcome.instance).pipe(
            Effect.tapError(() =>
              crews
                .removeMembers(
                  outcome.instance!.id,
                  input.seats.map((seat) => seat.name),
                )
                .pipe(Effect.ignore),
            ),
          );
        return {
          instance: outcome.instance,
          seats: input.seats.map((seat) => ({ seatName: seat.name, kind: "created" as const })),
        };
      }).pipe(Effect.mapError(launchFailure)),
  });

const withPreview = (gate: CrewProposalService["Service"]): CrewProposalService["Service"] => ({
  ...gate,
  resolve: (input: ResolveCrewProposalInput) =>
    Effect.gen(function* () {
      if (input.decision === "decline") return yield* gate.resolve(input);
      const preview = yield* gate.preview({
        proposalId: input.proposalId,
        ...(input.seats === undefined ? {} : { seats: input.seats }),
      });
      return yield* gate.resolve({ ...input, approvalToken: preview.approvalToken });
    }),
});

/** A live Crew of `size` scout seats, approved through the gate; the seat names are s0, s1, ... */
const seedCrew = (gate: CrewProposalService["Service"], requestKey: string, size: number) =>
  Effect.gen(function* () {
    const opened = yield* gate.propose({
      requestKey,
      captain,
      displayName: `Crew ${requestKey}`,
      brief: "Fill the seats.",
      seats: Array.from({ length: size }, (_, index) => ({
        seat: `s${index}`,
        agentId: "scout",
        reason: "Holds a seat",
      })),
    });
    const approved = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" });
    return approved.instance as AgentCrewInstance;
  });

/** How the gate refuses an addition the Crew cannot seat, whichever door it came through. */
const assertCrewFull = (error: { readonly _tag: string; readonly message: string }) => {
  assert.equal(error._tag, "CrewProposalRequestError");
  assert.include(error.message, "is full");
  assert.include(error.message, "propose a new crew");
};

const fixture = Effect.gen(function* () {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const storage = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer, ledgerLayer).pipe(
    Layer.provideMerge(database),
  );
  const context = yield* Layer.build(storage);
  const crews = Context.get(context, AgentCrewInstanceService);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Effect.provide(
    Effect.gen(function* () {
      yield* (yield* A2ALedger).createSquadron({
        squadron: {
          id: squadronId,
          name: "Proposal Squadron",
          createdAt: DateTime.formatIso(createdAt),
        },
      });
    }),
    context,
  );
  const captainModel = yield* Ref.make("gpt-5.6-sol");
  const notices = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  // Seat threads whose archive the store refuses, to prove a decline whose cleanup fails stays open.
  const noticeFailure = yield* Ref.make(false);
  const archiveFailures = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Seat threads that never came to exist (a not-found), and ones whose read the store cannot answer.
  const missingThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  const unreadableThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Threads the person archived, and ones they deleted (the store keeps the row, stamped).
  const archivedThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  const deletedThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
  // An approval is told to the Captain by the launch report, once its seats have started; here the
  // reporter records which proposals it was handed.
  const watched = yield* Ref.make<ReadonlyArray<string>>([]);
  // While set, a resolution lands nothing: the store answers as if the row were no longer open.
  const resolveFailure = yield* Ref.make(false);
  // While set, the proposal-to-Crew link write fails with a database error.
  const attachFailure = yield* Ref.make(false);
  const store = Context.get(context, AgentCrewProposalService);
  const flakyStore = Layer.succeed(AgentCrewProposalService, {
    ...store,
    resolve: (input) =>
      Ref.get(resolveFailure).pipe(
        Effect.flatMap((failing) => (failing ? Effect.succeed(null) : store.resolve(input))),
      ),
    attachInstance: (id, crewInstanceId) =>
      Ref.get(attachFailure).pipe(
        Effect.flatMap((failing) =>
          failing
            ? Effect.fail(
                new SqlError({ reason: new UnknownError({ cause: new Error("disk I/O error") }) }),
              )
            : store.attachInstance(id, crewInstanceId),
        ),
      ),
  });
  const layer = crewProposalLayer.pipe(
    Layer.provideMerge(flakyStore),
    Layer.provideMerge(fakeLauncher(crews)),
    Layer.provideMerge(
      Layer.mock(CrewLaunchReporter)({
        watch: (proposalId) => Ref.update(watched, (items) => [...items, proposalId]),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.gen(function* () {
            // The orchestrator wraps the store's failure either way; the cause tells them apart.
            if ((yield* Ref.get(missingThreads)).has(threadId))
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreThreadNotFoundError({ threadId }),
              });
            if ((yield* Ref.get(unreadableThreads)).has(threadId))
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreReadError({ threadId }),
              });
            return {
              thread: {
                ...thread(threadId),
                archivedAt: (yield* Ref.get(archivedThreads)).has(threadId) ? createdAt : null,
                deletedAt: (yield* Ref.get(deletedThreads)).has(threadId) ? createdAt : null,
                modelSelection: {
                  ...thread(threadId).modelSelection,
                  model: yield* Ref.get(captainModel),
                },
              },
            } as unknown as OrchestrationV2ThreadProjection;
          }),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (
              (command.type === "thread.archive" &&
                (yield* Ref.get(archiveFailures)).has(command.threadId)) ||
              (command.type === "message.dispatch" && (yield* Ref.get(noticeFailure)))
            )
              return yield* Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              );
            yield* Ref.update(notices, (items) => [...items, command]);
            return { events: [], effects: [] } as never;
          }),
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-proposal-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    notices,
    watched,
    archiveFailures,
    missingThreads,
    unreadableThreads,
    archivedThreads,
    deletedThreads,
    noticeFailure,
    resolveFailure,
    attachFailure,
    captainModel,
  };
});

it.effect(
  "holds a roster until the human approves, honours human-added seats, and hands the launch to the report",
  () =>
    Effect.gen(function* () {
      const { layer, notices, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const store = yield* AgentCrewProposalService;
        const seats = [
          { seat: "builder", agentId: "builder", reason: "Implements the fix" },
          { seat: "critic", agentId: "critic", reason: "Reviews it" },
        ];
        const open = yield* gate.propose({
          requestKey: "propose-1",
          captain,
          displayName: "Login Fix Crew",
          brief: "Fix the flaky login test.",
          seats,
        });
        assert.equal(open.proposal.status, "open");
        assert.isNull(open.instance);
        assert.lengthOf(yield* store.listOpen(), 1);
        assert.lengthOf(yield* Ref.get(notices), 0);

        const replay = yield* gate.propose({
          requestKey: "propose-1",
          captain,
          displayName: "Login Fix Crew",
          brief: "Fix the flaky login test.",
          seats,
        });
        assert.equal(replay.proposal.id, open.proposal.id);
        assert.lengthOf(yield* store.listOpen(), 1);

        const approved = yield* gate.resolve({
          proposalId: open.proposal.id,
          decision: "approve",
          seats: [
            ...seats,
            { seat: "sentry", agentId: "sentry", reason: "Human added a security pass" },
          ],
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual(
          approved.instance?.members.map((member) => member.seatName),
          ["builder", "critic", "sentry"],
        );
        assert.lengthOf(yield* store.listOpen(), 0);
        // Nothing is said to the Captain yet: the launch report speaks once the seats are up.
        assert.lengthOf(
          (yield* Ref.get(notices)).filter((command) => command.type === "message.dispatch"),
          0,
        );
        assert.deepStrictEqual(yield* Ref.get(watched), [open.proposal.id]);
        assert.isNull((yield* store.read(open.proposal.id))!.reportedAt);

        const again = yield* gate
          .resolve({ proposalId: open.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(again._tag, "CrewProposalNotOpenError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("gates every roster on the human and gates additions with the seat cap", () =>
  Effect.gen(function* () {
    const { layer, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const opened = yield* gate.propose({
        requestKey: "gate-1",
        captain,
        displayName: "Release Crew",
        brief: "Follow the release runbook.",
        seats: [{ seat: "builder", agentId: "builder", reason: "Release step 1" }],
      });
      assert.equal(opened.proposal.status, "open");
      assert.isNull(opened.instance);
      const approvedOutcome = yield* gate.resolve({
        proposalId: opened.proposal.id,
        decision: "approve",
      });
      assert.equal(approvedOutcome.proposal.status, "approved");
      const instance = approvedOutcome.instance as AgentCrewInstance;

      const request = yield* gate.requestMember({
        requestKey: "add-1",
        captain,
        crewInstanceId: null,
        seat: { seat: "critic", agentId: "critic", reason: "Needs review" },
        brief: null,
      });
      assert.equal(request.proposal.status, "open");
      assert.equal(request.proposal.kind, "addition");
      assert.equal(request.proposal.crewInstanceId, instance.id);
      assert.equal(request.proposal.brief, "Follow the release runbook.");

      const duplicate = yield* gate
        .requestMember({
          requestKey: "add-2",
          captain,
          crewInstanceId: instance.id,
          seat: { seat: "builder", agentId: "scout", reason: "Duplicate seat name" },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(duplicate.message, "already has a seat named builder");

      const unknown = yield* gate
        .requestMember({
          requestKey: "add-3",
          captain,
          crewInstanceId: instance.id,
          seat: { seat: "ghost", agentId: "nobody", reason: "Not in library" },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(unknown.message, 'names persona "nobody"');

      // A custom seat has nothing but its instructions to run on, so it cannot be filed without them.
      const bare = yield* gate
        .requestMember({
          requestKey: "add-custom-bare",
          captain,
          crewInstanceId: instance.id,
          seat: { seat: "scribe", agentId: null, reason: "Keeps notes" },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(bare.message, "A custom seat needs instructions");

      const blank = yield* gate
        .requestMember({
          requestKey: "add-custom-blank",
          captain,
          crewInstanceId: instance.id,
          seat: { seat: "scribe", agentId: null, reason: "Keeps notes", instructions: " \n\t " },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(blank.message, "Seat instructions");

      // A custom seat names no agent, so the library is not consulted; it is filed like any other.
      const custom = yield* gate.requestMember({
        requestKey: "add-custom",
        captain,
        crewInstanceId: instance.id,
        seat: {
          seat: "scribe",
          agentId: null,
          reason: "Keeps notes",
          instructions: "Write the running notes.",
        },
        brief: null,
      });
      assert.equal(custom.proposal.status, "open");
      assert.isNull(custom.proposal.requestedSeats[0]?.agentId);
      yield* gate.resolve({ proposalId: custom.proposal.id, decision: "decline" });

      const declined = yield* gate.resolve({
        proposalId: request.proposal.id,
        decision: "decline",
      });
      assert.equal(declined.proposal.status, "declined");
      assert.isNull(declined.instance);
      const last = (yield* Ref.get(notices)).at(-1);
      if (last?.type === "message.dispatch") assert.include(last.text, "decision: declined");

      const tooMany = yield* gate
        .propose({
          requestKey: "cap-1",
          captain,
          displayName: "Too Big",
          brief: "x",
          seats: Array.from({ length: CREW_SEAT_CAP + 1 }, (_, index) => ({
            seat: `s${index}`,
            agentId: "scout",
            reason: "r",
          })),
        })
        .pipe(Effect.flip);
      assert.include(tooMany.message, `at most ${CREW_SEAT_CAP} seats`);

      const notCaptain = yield* gate
        .requestMember({
          requestKey: "add-4",
          captain: { ...captain, participantId: ParticipantId.make("agent:j5:a2a:thread:other") },
          crewInstanceId: instance.id,
          seat: { seat: "x", agentId: "scout", reason: "r" },
          brief: null,
        })
        .pipe(Effect.flip);
      assert.include(notCaptain.message, "command no live crew");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "resolves a proposal before spawning and refuses approved seats the roster already has",
  () =>
    Effect.gen(function* () {
      const { layer, resolveFailure } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;

        // A failure before the Crew is recorded launches nothing and leaves the proposal open.
        const boom = yield* gate.propose({
          requestKey: "boom-1",
          captain,
          displayName: "Boom",
          brief: "This launch fails.",
          seats: [{ seat: "builder", agentId: "builder", reason: "r" }],
        });
        const failed = yield* gate
          .resolve({ proposalId: boom.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.equal((yield* proposals.read(boom.proposal.id))?.status, "open");

        const roster = yield* gate.propose({
          requestKey: "claim-1",
          captain,
          displayName: "Claim Crew",
          brief: "Build it.",
          seats: [{ seat: "builder", agentId: "builder", reason: "Builds" }],
        });
        const approved = yield* gate.resolve({
          proposalId: roster.proposal.id,
          decision: "approve",
        });
        assert.equal(approved.proposal.status, "approved");
        assert.equal(approved.proposal.crewInstanceId, approved.instance?.id);

        // A second approval finds the proposal resolved and never spawns again.
        const again = yield* gate
          .resolve({ proposalId: roster.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(again._tag, "CrewProposalNotOpenError");

        // The human edits an addition on the card into a seat name the crew already has.
        const addition = yield* gate.requestMember({
          requestKey: "claim-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: { seat: "critic", agentId: "critic", reason: "Reviews" },
          brief: null,
        });
        const duplicate = yield* gate
          .resolve({
            proposalId: addition.proposal.id,
            decision: "approve",
            seats: [{ seat: "builder", agentId: "critic", reason: "Renamed on the card" }],
          })
          .pipe(Effect.flip);
        assert.include(duplicate.message, "already has a seat named builder");
        assert.equal((yield* proposals.read(addition.proposal.id))?.status, "open");
        assert.lengthOf(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members,
          1,
        );

        // An addition whose approval cannot be recorded after its seat is reserved releases the
        // reservation and stays open, so approving it again is not refused as a name clash.
        const flaky = yield* gate.requestMember({
          requestKey: "flaky-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: { seat: "sentry", agentId: "critic", reason: "Security pass" },
          brief: null,
        });
        yield* Ref.set(resolveFailure, true);
        const firstTry = yield* gate
          .resolve({ proposalId: flaky.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        yield* Ref.set(resolveFailure, false);
        assert.equal(firstTry._tag, "CrewLaunchOperationError");
        assert.equal((yield* proposals.read(flaky.proposal.id))?.status, "open");
        assert.sameMembers(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members.map(
            ({ seatName }) => seatName,
          ),
          ["builder"],
        );
        const secondTry = yield* gate.resolve({
          proposalId: flaky.proposal.id,
          decision: "approve",
        });
        assert.equal(secondTry.proposal.status, "approved");
        assert.lengthOf(secondTry.instance!.members, 2);
        // A different proposal asking for that same seat name is still a clash.
        const clash = yield* gate
          .requestMember({
            requestKey: "clash-add-1",
            captain,
            crewInstanceId: approved.instance!.id,
            seat: { seat: "sentry", agentId: "critic", reason: "r" },
            brief: null,
          })
          .pipe(Effect.flip);
        assert.include(clash.message, "already has a seat named sentry");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("holds every door to the same seat shape and seats nobody into a retired Crew", () =>
  Effect.gen(function* () {
    const { layer } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* gate.propose({
        requestKey: "shape-1",
        captain,
        displayName: "Shape Crew",
        brief: "Mind the names.",
        seats: [{ seat: "builder", agentId: "builder", reason: "Builds" }],
      });
      // The card can submit any string; the rule the MCP schema enforces holds here too.
      for (const seat of ["", "Two Words", "colon:name", "x".repeat(101)]) {
        const refused = yield* gate
          .resolve({
            proposalId: opened.proposal.id,
            decision: "approve",
            seats: [{ seat, agentId: "builder", reason: "Builds" }],
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "CrewProposalRequestError", seat);
      }
      const tooLong = yield* gate
        .resolve({
          proposalId: opened.proposal.id,
          decision: "approve",
          seats: [{ seat: "builder", agentId: "builder", reason: "r".repeat(501) }],
        })
        .pipe(Effect.flip);
      assert.equal(tooLong._tag, "CrewProposalRequestError");

      const approved = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "approve" });
      const addition = yield* gate.requestMember({
        requestKey: "shape-add-1",
        captain,
        crewInstanceId: approved.instance!.id,
        seat: { seat: "critic", agentId: "critic", reason: "Reviews" },
        brief: null,
      });
      const rawGate = yield* CrewProposalService;
      const duplicateSeats = [{ seat: "builder", agentId: "critic", reason: "Already held" }];
      const duplicatePreview = yield* rawGate
        .preview({ proposalId: addition.proposal.id, seats: duplicateSeats })
        .pipe(Effect.flip);
      const duplicateApproval = yield* rawGate
        .resolve({ proposalId: addition.proposal.id, decision: "approve", seats: duplicateSeats })
        .pipe(Effect.flip);
      assert.equal(duplicatePreview._tag, "CrewProposalRequestError");
      assert.include(duplicatePreview.message, "already has a seat named builder");
      assert.equal(duplicateApproval.message, duplicatePreview.message);
      // archive_crew retires the Crew while the request still sits in the inbox.
      yield* crews.markArchived(approved.instance!.id, "2026-09-09T17:00:00.000Z");
      const late = yield* gate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(late._tag, "CrewProposalRequestError");
      assert.include(late.message, "retired");
      const retiredPreview = yield* rawGate
        .preview({ proposalId: addition.proposal.id })
        .pipe(Effect.flip);
      const retiredApproval = yield* rawGate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(retiredPreview._tag, "CrewProposalRequestError");
      assert.equal(retiredPreview.message, late.message);
      assert.equal(retiredApproval.message, retiredPreview.message);
      assert.lengthOf((yield* crews.read(approved.instance!.id))!.members, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("a decision that races another device's on the same gate is refused, not undone", () =>
  Effect.gen(function* () {
    const { layer, watched } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const roster = yield* gate.propose({
        requestKey: "race-1",
        captain,
        displayName: "Race Pair",
        brief: "Two devices decide at once.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      // Device A approves while device B declines: exactly one resolution lands.
      const [approval, decline] = yield* Effect.all(
        [
          Effect.result(gate.resolve({ proposalId: roster.proposal.id, decision: "approve" })),
          Effect.result(gate.resolve({ proposalId: roster.proposal.id, decision: "decline" })),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [approval, decline].map((result) =>
        Result.isSuccess(result) ? result.success.proposal.status : result.failure._tag,
      );
      assert.sameMembers(
        outcomes,
        outcomes.includes("approved")
          ? ["approved", "CrewProposalNotOpenError"]
          : ["declined", "CrewProposalNotOpenError"],
      );
      const final = (yield* proposals.read(roster.proposal.id))!;
      assert.include(["approved", "declined"], final.status);
      // Only a winning approval launches and is reported.
      assert.deepStrictEqual(
        yield* Ref.get(watched),
        final.status === "approved" ? [roster.proposal.id] : [],
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "an approval launches once: a seat that is never created is reported, and nothing can resolve it again",
  () =>
    Effect.gen(function* () {
      const { layer, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const roster = yield* gate.propose({
          requestKey: "once-1",
          captain,
          displayName: "Boom after record",
          brief: "The second seat never spawns.",
          seats: [
            { seat: "builder", agentId: "builder", reason: "Builds" },
            { seat: "critic", agentId: "critic", reason: "Reviews" },
          ],
        });
        // The approval resolves the card even though one seat was never created.
        const approved = yield* gate.resolve({
          proposalId: roster.proposal.id,
          decision: "approve",
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual(
          approved.instance?.members.map((member) => member.seatName),
          ["builder"],
        );
        assert.deepStrictEqual(
          (yield* crews.read(approved.instance!.id))!.members.map((member) => member.seatName),
          ["builder"],
        );
        assert.deepStrictEqual(yield* Ref.get(watched), [roster.proposal.id]);
        // Neither a second approval nor a decline follows; nothing is launched or retired.
        for (const decision of ["approve", "decline"] as const) {
          const again = yield* gate
            .resolve({ proposalId: roster.proposal.id, decision })
            .pipe(Effect.flip);
          assert.equal(again._tag, "CrewProposalNotOpenError");
        }
        assert.isNull((yield* crews.read(approved.instance!.id))!.archivedAt);
        assert.equal((yield* proposals.read(roster.proposal.id))!.status, "approved");
        assert.lengthOf(yield* Ref.get(watched), 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a failed decline notice leaves the decision retryable", () =>
  Effect.gen(function* () {
    const { layer, noticeFailure, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const store = yield* AgentCrewProposalService;
      const open = yield* gate.propose({
        requestKey: "decline-notice-failure",
        captain,
        displayName: "Review",
        brief: "Review the change",
        seats: [{ seat: "critic", agentId: "critic", reason: "Review" }],
      });
      yield* Ref.set(noticeFailure, true);
      yield* gate.resolve({ proposalId: open.proposal.id, decision: "decline" }).pipe(Effect.flip);
      assert.equal((yield* store.read(open.proposal.id))?.status, "open");
      yield* Ref.set(noticeFailure, false);
      const result = yield* gate.resolve({ proposalId: open.proposal.id, decision: "decline" });
      assert.equal(result.proposal.status, "declined");
      assert.lengthOf(yield* Ref.get(notices), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "requires the displayed runtime token and refuses changed defaults or edited seats before claiming approval",
  () =>
    Effect.gen(function* () {
      const { layer, captainModel } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const open = yield* gate.propose({
          requestKey: "preview-token",
          captain,
          displayName: "Review",
          brief: "Review changes",
          seats: [{ seat: "reader", agentId: null, reason: "Read", instructions: "Read changes" }],
        });
        const proposalId = open.proposal.id;
        const preview = yield* gate.preview({ proposalId });
        assert.equal(preview.seats[0]?.model, "gpt-5.6-sol");
        const missing = yield* gate.resolve({ proposalId, decision: "approve" }).pipe(Effect.flip);
        assert.equal(missing._tag, "CrewProposalRequestError");
        const edited = yield* gate
          .resolve({
            proposalId,
            decision: "approve",
            approvalToken: preview.approvalToken,
            seats: [{ ...open.proposal.requestedSeats[0]!, instructions: "Write changes" }],
          })
          .pipe(Effect.flip);
        assert.equal(edited._tag, "CrewProposalRequestError");
        yield* Ref.set(captainModel, "gpt-6-astra");
        const stale = yield* gate
          .resolve({ proposalId, decision: "approve", approvalToken: preview.approvalToken })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "CrewProposalRequestError");
        assert.equal((yield* store.read(proposalId))?.status, "open");
        assert.lengthOf(yield* crews.listLive(), 0);
        const refreshed = yield* gate.preview({ proposalId });
        assert.equal(refreshed.seats[0]?.model, "gpt-6-astra");
        const approved = yield* gate.resolve({
          proposalId,
          decision: "approve",
          approvalToken: refreshed.approvalToken,
        });
        assert.equal(approved.proposal.status, "approved");
        const addition = yield* gate.requestMember({
          requestKey: "preview-addition",
          captain,
          crewInstanceId: approved.instance!.id,
          brief: null,
          seat: { seat: "writer", agentId: null, reason: "Write", instructions: "Write notes" },
        });
        const additionPreview = yield* gate.preview({ proposalId: addition.proposal.id });
        yield* Ref.set(captainModel, "gpt-5.6-sol");
        const staleAddition = yield* gate
          .resolve({
            proposalId: addition.proposal.id,
            decision: "approve",
            approvalToken: additionPreview.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(staleAddition._tag, "CrewProposalRequestError");
        assert.lengthOf((yield* crews.read(approved.instance!.id))!.members, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "persists custom runtime overrides through proposal storage, human edits, and approval",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
        const store = yield* AgentCrewProposalService;
        const proposed = {
          seat: "custom-reviewer",
          agentId: null,
          reason: "Reviews",
          instructions: "Review the change",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-work"),
            model: "claude-sonnet",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "approval-required" as const,
        };
        const open = yield* gate.propose({
          requestKey: "custom-config-recovery",
          captain,
          displayName: "Custom Review",
          brief: "Review",
          seats: [proposed],
        });
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.requestedSeats, [proposed]);
        const first = yield* gate.preview({ proposalId: open.proposal.id });
        assert.deepStrictEqual(first.seats[0]?.modelSelection, proposed.modelSelection);
        assert.equal(first.seats[0]?.runtimeMode, "approval-required");
        const edited = {
          ...proposed,
          runtimeMode: "full-access" as const,
          modelSelection: { ...proposed.modelSelection, options: [{ id: "effort", value: "low" }] },
        };
        const stale = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            decision: "approve",
            seats: [edited],
            approvalToken: first.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "CrewProposalRequestError");
        const current = yield* gate.preview({ proposalId: open.proposal.id, seats: [edited] });
        assert.deepStrictEqual(current.seats[0]?.modelSelection, edited.modelSelection);
        assert.equal(current.seats[0]?.runtimeMode, edited.runtimeMode);
        const savedSeat = { ...edited, agentId: "critic" };
        const savedOverride = yield* gate.preview({
          proposalId: open.proposal.id,
          seats: [savedSeat],
        });
        assert.deepStrictEqual(savedOverride.seats[0]?.modelSelection, edited.modelSelection);
        assert.equal(savedOverride.seats[0]?.runtimeMode, edited.runtimeMode);
        assert.notEqual(savedOverride.approvalToken, current.approvalToken);
        const stalePersona = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            seats: [savedSeat],
            decision: "approve",
            approvalToken: current.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(stalePersona._tag, "CrewProposalRequestError");
        const approved = yield* gate.resolve({
          proposalId: open.proposal.id,
          seats: [savedSeat],
          decision: "approve",
          approvalToken: savedOverride.approvalToken,
        });
        assert.equal(approved.proposal.status, "approved");
        assert.deepStrictEqual((yield* store.read(open.proposal.id))?.approvedSeats, [savedSeat]);
        const agentOverride = yield* gate
          .propose({
            requestKey: "agent-saved-override",
            captain,
            displayName: "Review",
            brief: "Review",
            seats: [savedSeat],
          })
          .pipe(Effect.flip);
        assert.equal(agentOverride._tag, "CrewProposalRequestError");
        assert.include(agentOverride.message, "only the human can override");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "two requests racing at eleven held seats admit exactly one, and the winner's retry is not a thirteenth",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* seedCrew(gate, "race-cap", 11);
        const request = (requestKey: string, seat: string) =>
          gate.requestMember({
            requestKey,
            captain,
            crewInstanceId: instance.id,
            seat: { seat, agentId: "scout", reason: "Wants the last seat" },
            brief: null,
          });

        // Both count eleven rows and no open request unless the count and the filing are one
        // decision: exactly one may be filed.
        const outcomes = yield* Effect.all(
          [Effect.result(request("race-a", "left")), Effect.result(request("race-b", "right"))],
          { concurrency: "unbounded" },
        );
        const admitted = outcomes.filter(Result.isSuccess).map((result) => result.success);
        const refused = outcomes.filter(Result.isFailure).map((result) => result.failure);
        assert.lengthOf(admitted, 1);
        assert.lengthOf(refused, 1);
        assert.equal(admitted[0]!.proposal.status, "open");
        assertCrewFull(refused[0]!);
        assert.include(refused[0]!.message, `holds 12 of ${CREW_SEAT_CAP} seats`);
        const openAdditions = (yield* proposals.listForCaptain(captainId)).filter(
          (proposal) => proposal.crewInstanceId === instance.id && proposal.status === "open",
        );
        assert.lengthOf(openAdditions, 1);
        assert.lengthOf((yield* crews.read(instance.id))!.members, 11);

        // The request holding seat twelve is found by its key before anything is counted, so a
        // retry is the same request, not a thirteenth seat.
        const winner = admitted[0]!.proposal;
        const winnerKey = winner.requestedSeats[0]!.seat === "left" ? "race-a" : "race-b";
        const replay = yield* request(winnerKey, winner.requestedSeats[0]!.seat);
        assert.equal(replay.proposal.id, winner.id);
        assert.equal(replay.proposal.status, "open");
        assert.lengthOf(
          (yield* proposals.listForCaptain(captainId)).filter(
            (proposal) => proposal.crewInstanceId === instance.id && proposal.status === "open",
          ),
          1,
        );
        const approved = yield* gate.resolve({ proposalId: winner.id, decision: "approve" });
        assert.equal(approved.proposal.status, "approved");
        assert.lengthOf(approved.instance!.members, 12);
        // Replayed after its seat launched: the seat name is now a member, and the retry still
        // gets its own proposal back rather than a clash or a full-crew refusal.
        const afterLaunch = yield* request(winnerKey, winner.requestedSeats[0]!.seat);
        assert.equal(afterLaunch.proposal.id, winner.id);
        assert.equal(afterLaunch.proposal.status, "approved");
        assert.lengthOf(afterLaunch.instance!.members, 12);
        // The loser's key never filed anything, so its retry is counted afresh and still refused.
        assertCrewFull(
          yield* request(winnerKey === "race-a" ? "race-b" : "race-a", "late").pipe(Effect.flip),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a roster whose Crew link cannot be written fails its approval and is never reported",
  () =>
    Effect.gen(function* () {
      const { layer, attachFailure, watched } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;
        const opened = yield* gate.propose({
          requestKey: "link-fails",
          captain,
          displayName: "Unlinked Crew",
          brief: "Build it.",
          seats: [{ seat: "maker", agentId: "builder", reason: "Builds" }],
        });
        yield* Ref.set(attachFailure, true);
        // The launch report finds its Crew through the link, so a swallowed failure would launch
        // seats the Captain is never told about; the approval fails instead, before any spawn.
        const failed = yield* gate
          .resolve({ proposalId: opened.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        assert.include(failed.message, `linking proposal ${opened.proposal.id}`);
        const after = (yield* proposals.read(opened.proposal.id))!;
        assert.notEqual(after.status, "approved");
        assert.isNull(after.crewInstanceId);
        assert.deepStrictEqual(yield* Ref.get(watched), []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect("a roster left open while its Captain was archived is refused, and still declines", () =>
  Effect.gen(function* () {
    const { layer, archivedThreads, watched } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* gate.propose({
        requestKey: "archived-captain",
        captain,
        displayName: "Late Crew",
        brief: "Pick up after the Captain.",
        seats: [{ seat: "builder", agentId: "builder", reason: "Builds" }],
      });
      yield* Ref.set(archivedThreads, new Set([captainThread]));

      // The card's preview and its approval both meet the refusal, naming the Captain.
      const previewed = yield* gate.preview({ proposalId: opened.proposal.id }).pipe(Effect.flip);
      assert.equal(previewed._tag, "CrewProposalRequestError");
      assert.include(previewed.message, `Captain Thread ${captainThread} is archived`);
      const refused = yield* gate
        .resolve({ proposalId: opened.proposal.id, decision: "approve", approvalToken: "stale" })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewProposalRequestError");
      assert.include(refused.message, "Unarchive the Captain");
      assert.isNull(yield* crews.read(`crew:archived-captain`));
      assert.lengthOf(yield* Ref.get(watched), 0);

      const declined = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "a roster or addition left open while its Captain was deleted is refused, and declines untold",
  () =>
    Effect.gen(function* () {
      const { layer, deletedThreads, missingThreads, notices } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const crews = yield* AgentCrewInstanceService;
        const instance = yield* seedCrew(gate, "deleted-captain-crew", 1);
        const roster = yield* gate.propose({
          requestKey: "deleted-captain",
          captain,
          displayName: "Orphan Crew",
          brief: "Nobody commands this.",
          seats: [{ seat: "builder", agentId: "builder", reason: "Builds" }],
        });
        const addition = yield* gate.requestMember({
          requestKey: "deleted-captain-add",
          captain,
          crewInstanceId: instance.id,
          seat: { seat: "critic", agentId: "critic", reason: "Reviews" },
          brief: null,
        });
        yield* Ref.set(deletedThreads, new Set([captainThread]));
        const toldBefore = (yield* Ref.get(notices)).length;

        for (const proposalId of [roster.proposal.id, addition.proposal.id]) {
          const refused = yield* gate
            .resolve({ proposalId, decision: "approve" })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "CrewProposalRequestError");
          assert.include(refused.message, `Captain Thread ${captainThread} has been deleted`);
        }
        assert.isNull(yield* crews.read(`crew:deleted-captain`));
        assert.deepStrictEqual(
          (yield* crews.read(instance.id))!.members.map((member) => member.seatName),
          ["s0"],
        );

        // A Captain the store no longer holds at all reads the same way.
        yield* Ref.set(missingThreads, new Set([captainThread]));
        const gone = yield* gate
          .resolve({ proposalId: roster.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.include(gone.message, `Captain ${captainId} has been deleted`);

        for (const proposalId of [roster.proposal.id, addition.proposal.id]) {
          const declined = yield* gate.resolve({ proposalId, decision: "decline" });
          assert.equal(declined.proposal.status, "declined");
        }
        assert.lengthOf(yield* Ref.get(notices), toldBefore);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
