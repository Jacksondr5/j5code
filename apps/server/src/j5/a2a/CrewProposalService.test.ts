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
              Effect.flatMap((instance) =>
                input.displayName === "Boom after record"
                  ? Effect.fail(launchFailure(new Error("second seat failed to spawn")))
                  : Effect.succeed(instance),
              ),
            ),
    // Additions reserve rows under the real deterministic ids before spawning, like the launcher;
    // a brief of "fail once" (or "fail twice") then fails that many spawns to leave the
    // reservation behind.
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
        const wanted = input.brief === "fail twice" ? 2 : input.brief === "fail once" ? 1 : 0;
        const failedSoFar = failures.get(input.requestKey) ?? 0;
        if (failedSoFar < wanted) {
          failures.set(input.requestKey, failedSoFar + 1);
          return yield* Effect.fail(launchFailure(new Error("spawn failed after reserving")));
        }
        return outcome.instance!;
      }).pipe(Effect.mapError(launchFailure)),
  });
/** How many times each addition request has failed so far; briefs "fail once" and "fail twice". */
const failures = new Map<string, number>();

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
  const database = NodeSqliteClient.layerMemory();
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
  // An approval is told to the Captain by the launch report, once its seats have started; here the
  // reporter records which proposals it was handed.
  const watched = yield* Ref.make<ReadonlyArray<string>>([]);
  // While set, recording a resolution lands nothing: the store answers as if the row were no
  // longer claimed, which is what a decline sees when its final write fails after the notice.
  const completeFailure = yield* Ref.make(false);
  const store = Context.get(context, AgentCrewProposalService);
  const flakyStore = Layer.succeed(AgentCrewProposalService, {
    ...store,
    complete: (input) =>
      Ref.get(completeFailure).pipe(
        Effect.flatMap((failing) => (failing ? Effect.succeed(null) : store.complete(input))),
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
    noticeFailure,
    completeFailure,
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
  "claims a proposal before spawning and refuses approved seats the roster already has",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = withPreview(yield* CrewProposalService);
        const proposals = yield* AgentCrewProposalService;

        // A failed spawn hands the gate back instead of recording a phantom approval.
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

        // A second approval finds the proposal claimed and never spawns again.
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

        // A spawn that fails after reserving its seat hands the gate back; the retry must
        // recognize its own reservation instead of refusing the seat as taken forever.
        const flaky = yield* gate.requestMember({
          requestKey: "flaky-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: { seat: "sentry", agentId: "critic", reason: "Security pass" },
          brief: "fail once",
        });
        const firstTry = yield* gate
          .resolve({ proposalId: flaky.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.equal(firstTry._tag, "CrewLaunchOperationError");
        assert.equal((yield* proposals.read(flaky.proposal.id))?.status, "open");
        const reserved = (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!;
        assert.sameMembers(
          reserved.members.map(({ seatName }) => seatName),
          ["builder", "sentry"],
        );
        const secondTry = yield* gate.resolve({
          proposalId: flaky.proposal.id,
          decision: "approve",
        });
        assert.equal(secondTry.proposal.status, "approved");
        assert.lengthOf(secondTry.instance!.members, 2);
        // Declining after a failed spawn releases the reservation the spawn left behind.
        const abandoned = yield* gate.requestMember({
          requestKey: "abandoned-add-1",
          captain,
          crewInstanceId: approved.instance!.id,
          seat: { seat: "ranger", agentId: "critic", reason: "Recon" },
          brief: "fail once",
        });
        yield* gate
          .resolve({ proposalId: abandoned.proposal.id, decision: "approve" })
          .pipe(Effect.flip);
        assert.include(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members.map(
            ({ seatName }) => seatName,
          ),
          "ranger",
        );
        yield* gate.resolve({ proposalId: abandoned.proposal.id, decision: "decline" });
        assert.sameMembers(
          (yield* (yield* AgentCrewInstanceService).read(approved.instance!.id))!.members.map(
            ({ seatName }) => seatName,
          ),
          ["builder", "sentry"],
        );
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

it.effect("declining a roster whose launch failed partway retires what the launch created", () =>
  Effect.gen(function* () {
    const { layer, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const crews = yield* AgentCrewInstanceService;
      const opened = yield* gate.propose({
        requestKey: "partial-1",
        captain,
        displayName: "Boom after record",
        brief: "The second seat never spawns.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      const edited = [
        { seat: "builder", agentId: "builder", reason: "Builds" },
        { seat: "reviewer", agentId: "critic", reason: "Renamed on the card" },
      ];
      const failed = yield* gate
        .resolve({ proposalId: opened.proposal.id, decision: "approve", seats: edited })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "CrewLaunchOperationError");
      // The gate is handed back with the person's edits and the Crew it already names intact.
      const reopened = (yield* proposals.read(opened.proposal.id))!;
      assert.equal(reopened.status, "open");
      assert.deepStrictEqual(reopened.approvedSeats, edited);
      assert.equal(reopened.crewInstanceId, `crew:${opened.proposal.id}`);
      assert.isNotNull(yield* crews.read(reopened.crewInstanceId!));

      const declined = yield* gate.resolve({ proposalId: opened.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
      const retired = (yield* crews.read(reopened.crewInstanceId!))!;
      assert.isNotNull(retired.archivedAt);
      // Every seat the failed launch created is archived, under its own stable command id.
      const archived = (yield* Ref.get(notices)).filter(
        (command) => command.type === "thread.archive",
      );
      assert.sameMembers(
        archived.map((command) => command.threadId),
        [ThreadId.make("thread:builder"), ThreadId.make("thread:reviewer")],
      );
      // Nothing of it is seated any more, and the Captain heard the decline.
      assert.isNull(yield* crews.findMembership(ParticipantId.make("agent:j5:a2a:thread:builder")));
      const notice = (yield* Ref.get(notices)).at(-1);
      assert.equal(notice?.type, "message.dispatch");
      if (notice?.type === "message.dispatch") assert.include(notice.text, "decision: declined");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("a decline cleans up before it is recorded, and releases every name it reserved", () =>
  Effect.gen(function* () {
    const { layer, notices, archiveFailures } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const crews = yield* AgentCrewInstanceService;

      // A roster whose launch failed partway: while a seat's archive fails, the decline is not
      // recorded, so the person can decline again once the store recovers.
      const roster = yield* gate.propose({
        requestKey: "cleanup-1",
        captain,
        displayName: "Boom after record",
        brief: "The second seat never spawns.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      yield* Ref.set(archiveFailures, new Set(["thread:critic"]));
      const stuck = yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "decline" })
        .pipe(Effect.flip);
      assert.equal(stuck._tag, "CrewProposalOperationError");
      const stillOpen = (yield* proposals.read(roster.proposal.id))!;
      assert.equal(stillOpen.status, "open");
      assert.isNull((yield* crews.read(stillOpen.crewInstanceId!))!.archivedAt);
      yield* Ref.set(archiveFailures, new Set());
      const declined = yield* gate.resolve({ proposalId: roster.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
      assert.isNotNull((yield* crews.read(stillOpen.crewInstanceId!))!.archivedAt);

      // An addition renamed between two failed attempts reserved two names; declining releases
      // both, not only the last one the person approved.
      const live = yield* gate.propose({
        requestKey: "cleanup-2",
        captain,
        displayName: "Live Crew",
        brief: "Build it.",
        // The fake launcher mints seat ids from names alone, so this roster reuses none above.
        seats: [{ seat: "maker", agentId: "builder", reason: "Builds" }],
      });
      const approved = yield* gate.resolve({ proposalId: live.proposal.id, decision: "approve" });
      const addition = yield* gate.requestMember({
        requestKey: "cleanup-add-1",
        captain,
        crewInstanceId: approved.instance!.id,
        seat: { seat: "scout", agentId: "critic", reason: "Recon" },
        brief: "fail twice",
      });
      yield* gate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      yield* gate
        .resolve({
          proposalId: addition.proposal.id,
          decision: "approve",
          seats: [{ seat: "ranger", agentId: "critic", reason: "Renamed on the card" }],
        })
        .pipe(Effect.flip);
      assert.sameMembers(
        (yield* crews.read(approved.instance!.id))!.members.map(({ seatName }) => seatName),
        ["maker", "scout", "ranger"],
      );
      // The reopened gate carries the person's edit, which is what the card reseeds from.
      assert.deepStrictEqual(
        (yield* proposals.read(addition.proposal.id))!.approvedSeats?.map(({ seat }) => seat),
        ["ranger"],
      );
      yield* gate.resolve({ proposalId: addition.proposal.id, decision: "decline" });
      const afterwards = (yield* crews.read(approved.instance!.id))!;
      assert.deepStrictEqual(
        afterwards.members.map(({ seatName }) => seatName),
        ["maker"],
      );
      assert.isNull(afterwards.archivedAt);
      // Both reserved seat threads were archived under their own stable command ids.
      const archived = (yield* Ref.get(notices))
        .filter((command) => command.type === "thread.archive")
        .map((command) => command.threadId);
      for (const seat of ["scout", "ranger"])
        assert.include(
          archived,
          spawnThreadId({
            providerSessionId: "j5-crew-proposal",
            requestKey: crewSeatRequestKey(addition.proposal.id, seat),
          }),
        );
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
    const { layer } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const crews = yield* AgentCrewInstanceService;

      // A roster whose launch failed partway, handed back with its Crew already recorded: the
      // shape both devices see when they resolve the reopened gate at once.
      const roster = yield* gate.propose({
        requestKey: "race-1",
        captain,
        displayName: "Boom after record",
        brief: "The second seat never spawns.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      const crewId = (yield* proposals.read(roster.proposal.id))!.crewInstanceId!;

      // Device A's approval holds the claim while its launch runs; device B's decline arrives.
      const held = yield* proposals.claim({
        id: roster.proposal.id,
        decision: "approve",
        approvedSeats: null,
      });
      assert.equal(held?.status, "approving");
      const refused = yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "decline" })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "CrewProposalNotOpenError");
      if (refused._tag === "CrewProposalNotOpenError") assert.equal(refused.status, "approving");
      // The decline did no cleanup over the approval: the Crew A is launching is still live.
      assert.isNull((yield* crews.read(crewId))!.archivedAt);
      assert.equal((yield* proposals.read(roster.proposal.id))!.status, "approving");

      // The mirror image: a decline holds the claim while it cleans up; an approval arrives.
      yield* proposals.reopen(roster.proposal.id);
      const declining = yield* proposals.claim({
        id: roster.proposal.id,
        decision: "decline",
        approvedSeats: null,
      });
      assert.equal(declining?.status, "declining");
      const lateApproval = yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(lateApproval._tag, "CrewProposalNotOpenError");
      // Only the claim holder can write the final status; a second claim finds nothing open.
      assert.isNull(
        yield* proposals.claim({
          id: roster.proposal.id,
          decision: "approve",
          approvedSeats: null,
        }),
      );

      // Once the claim is released the person decides again and the decline goes through whole.
      yield* proposals.reopen(roster.proposal.id);
      const declined = yield* gate.resolve({ proposalId: roster.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
      assert.isNotNull((yield* crews.read(crewId))!.archivedAt);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("a decline whose notice committed is never handed back to the opposite choice", () =>
  Effect.gen(function* () {
    const { layer, notices, completeFailure } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
      const proposals = yield* AgentCrewProposalService;
      const roster = yield* gate.propose({
        requestKey: "declined-stays-1",
        captain,
        displayName: "Declined stays declined",
        brief: "Build it.",
        seats: [{ seat: "maker", agentId: "builder", reason: "Builds" }],
      });
      // The Captain's decline card is durable, then the final status write fails.
      yield* Ref.set(completeFailure, true);
      const failed = yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "decline" })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "CrewProposalOperationError");
      const told = (yield* Ref.get(notices)).findLast(
        (command) => command.type === "message.dispatch",
      );
      if (told?.type === "message.dispatch") assert.include(told.text, "decision: declined");
      else assert.fail("the decline notice was not dispatched");
      // Reopening now would let an approval launch a Crew beneath a card that says declined;
      // a claimed row refuses every resolution until the boot sweep records the decline.
      assert.equal((yield* proposals.read(roster.proposal.id))!.status, "declining");
      // The boot sweep finishes the lost decline once the store recovers.
      yield* Ref.set(completeFailure, false);
      assert.deepStrictEqual(yield* gate.reconcile, [roster.proposal.id]);
      assert.equal((yield* proposals.read(roster.proposal.id))!.status, "declined");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("the boot sweep finishes a decline the server lost and hands a lost approval back", () =>
  Effect.gen(function* () {
    const { layer, notices } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const crews = yield* AgentCrewInstanceService;

      // A decline claimed, then the server died before the cleanup and the final status landed.
      const lost = yield* gate.propose({
        requestKey: "sweep-1",
        captain,
        displayName: "Boom after record",
        brief: "The second seat never spawns.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      yield* gate.resolve({ proposalId: lost.proposal.id, decision: "approve" }).pipe(Effect.flip);
      yield* proposals.claim({ id: lost.proposal.id, decision: "decline", approvedSeats: null });
      // An approval claimed, then lost the same way; its launch converges on a retry, so the
      // gate is handed back rather than guessed at.
      const handedBack = yield* gate.propose({
        requestKey: "sweep-2",
        captain,
        displayName: "Sweep Crew",
        brief: "Build it.",
        seats: [{ seat: "maker", agentId: "builder", reason: "Builds" }],
      });
      yield* proposals.claim({
        id: handedBack.proposal.id,
        decision: "approve",
        approvedSeats: handedBack.proposal.requestedSeats,
      });

      assert.sameMembers([...(yield* gate.reconcile)], [lost.proposal.id, handedBack.proposal.id]);
      const declined = (yield* proposals.read(lost.proposal.id))!;
      assert.equal(declined.status, "declined");
      assert.isNotNull((yield* crews.read(declined.crewInstanceId!))!.archivedAt);
      const notice = (yield* Ref.get(notices)).findLast(
        (command) => command.type === "message.dispatch",
      );
      if (notice?.type === "message.dispatch") assert.include(notice.text, "decision: declined");
      const reopened = (yield* proposals.read(handedBack.proposal.id))!;
      assert.equal(reopened.status, "open");
      assert.deepStrictEqual(reopened.approvedSeats, handedBack.proposal.requestedSeats);
      // Nothing left claimed; a second sweep is a no-op.
      assert.deepStrictEqual(yield* gate.reconcile, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("a seat thread that never existed is skipped; a store that cannot answer is not", () =>
  Effect.gen(function* () {
    const { layer, notices, missingThreads, unreadableThreads } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = withPreview(yield* CrewProposalService);
      const proposals = yield* AgentCrewProposalService;
      const crews = yield* AgentCrewInstanceService;
      const roster = yield* gate.propose({
        requestKey: "reads-1",
        captain,
        displayName: "Boom after record",
        brief: "The second seat never spawns.",
        seats: [
          { seat: "builder", agentId: "builder", reason: "Builds" },
          { seat: "critic", agentId: "critic", reason: "Reviews" },
        ],
      });
      yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      const crewId = (yield* proposals.read(roster.proposal.id))!.crewInstanceId!;

      // The store cannot read the builder's thread: the decline fails, the gate is handed back,
      // and no row is dropped from under a thread that may well be live.
      yield* Ref.set(unreadableThreads, new Set(["thread:builder"]));
      const failed = yield* gate
        .resolve({ proposalId: roster.proposal.id, decision: "decline" })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "CrewProposalOperationError");
      assert.include(failed.message, "reading seat builder");
      assert.equal((yield* proposals.read(roster.proposal.id))!.status, "open");
      assert.isNull((yield* crews.read(crewId))!.archivedAt);
      assert.lengthOf((yield* crews.read(crewId))!.members, 2);

      // The critic's thread never came to exist: that is a fact, so the decline passes it by and
      // archives only the builder's.
      yield* Ref.set(unreadableThreads, new Set());
      yield* Ref.set(missingThreads, new Set(["thread:critic"]));
      const declined = yield* gate.resolve({ proposalId: roster.proposal.id, decision: "decline" });
      assert.equal(declined.proposal.status, "declined");
      assert.isNotNull((yield* crews.read(crewId))!.archivedAt);
      assert.deepStrictEqual(
        (yield* Ref.get(notices))
          .filter((command) => command.type === "thread.archive")
          .map((command) => command.threadId),
        [ThreadId.make("thread:builder")],
      );
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
  "persists custom runtime overrides through proposal storage, human edits, and failed-launch recovery",
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
          displayName: "Boom",
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
        const failed = yield* gate
          .resolve({
            proposalId: open.proposal.id,
            decision: "approve",
            seats: [edited],
            approvalToken: current.approvalToken,
          })
          .pipe(Effect.flip);
        assert.equal(failed._tag, "CrewLaunchOperationError");
        const reopened = (yield* store.read(open.proposal.id))!;
        assert.equal(reopened.status, "open");
        assert.deepStrictEqual(reopened.approvedSeats, [edited]);
        const retry = yield* gate.preview({ proposalId: open.proposal.id });
        assert.equal(retry.approvalToken, current.approvalToken);
        assert.deepStrictEqual(retry.seats[0]?.modelSelection, edited.modelSelection);
        assert.equal(retry.seats[0]?.runtimeMode, edited.runtimeMode);
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
        yield* gate
          .resolve({
            proposalId: open.proposal.id,
            seats: [savedSeat],
            decision: "approve",
            approvalToken: savedOverride.approvalToken,
          })
          .pipe(Effect.flip);
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
