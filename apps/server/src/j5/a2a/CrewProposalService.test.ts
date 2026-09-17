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

import { ServerConfig } from "../../config.ts";
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
import {
  CrewLaunchOperationError,
  CrewLaunchService,
  type CrewCaptain,
} from "./CrewLaunchService.ts";
import {
  CREW_SEAT_CAP,
  CrewProposalService,
  layer as crewProposalLayer,
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
    // a brief of "fail once" then fails the spawn the first time to leave that reservation behind.
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
        if (input.brief === "fail once" && !failedOnce.has(input.requestKey)) {
          failedOnce.add(input.requestKey);
          return yield* Effect.fail(launchFailure(new Error("spawn failed after reserving")));
        }
        return outcome.instance!;
      }).pipe(Effect.mapError(launchFailure)),
  });
const failedOnce = new Set<string>();

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
  const notices = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  const layer = crewProposalLayer.pipe(
    Layer.provideMerge(fakeLauncher(crews)),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.succeed({
            thread: thread(threadId),
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Ref.update(notices, (items) => [...items, command]).pipe(
            Effect.as({ events: [], effects: [] } as never),
          ),
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "j5-crew-proposal-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, notices };
});

it.effect(
  "holds a roster until the human approves, honours human-added seats, and notifies the Captain",
  () =>
    Effect.gen(function* () {
      const { layer, notices } = yield* fixture;
      yield* Effect.gen(function* () {
        const gate = yield* CrewProposalService;
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
        const notice = (yield* Ref.get(notices))[0];
        assert.equal(notice?.type, "message.dispatch");
        if (notice?.type === "message.dispatch") {
          assert.equal(notice.threadId, captainThread);
          assert.equal(notice.createdBy, "system");
          assert.include(notice.text, "decision: approved");
          assert.include(notice.text, `crew_instance_id: ${approved.instance?.id}`);
          assert.include(notice.text, "- sentry: participant_id=");
        }

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
      const gate = yield* CrewProposalService;
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
      const approvedNotice = (yield* Ref.get(notices))[0];
      if (approvedNotice?.type === "message.dispatch")
        assert.include(approvedNotice.text, "decision: approved");
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
      assert.include(unknown.message, 'names agent "nobody"');

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
        const gate = yield* CrewProposalService;
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
      const gate = yield* CrewProposalService;
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

it.effect("holds every door to the same seat shape and seats nobody into a retired Crew", () =>
  Effect.gen(function* () {
    const { layer } = yield* fixture;
    yield* Effect.gen(function* () {
      const gate = yield* CrewProposalService;
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
      // archive_crew retires the Crew while the request still sits in the inbox.
      yield* crews.markArchived(approved.instance!.id, "2026-09-09T17:00:00.000Z");
      const late = yield* gate
        .resolve({ proposalId: addition.proposal.id, decision: "approve" })
        .pipe(Effect.flip);
      assert.equal(late._tag, "CrewProposalRequestError");
      assert.include(late.message, "retired");
      assert.lengthOf((yield* crews.read(approved.instance!.id))!.members, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
