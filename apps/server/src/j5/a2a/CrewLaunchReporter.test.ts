import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  AgentCrewInstanceService,
  layer as crewInstanceLayer,
} from "./AgentCrewInstanceService.ts";
import {
  AgentCrewProposalService,
  layer as proposalStoreLayer,
} from "./AgentCrewProposalService.ts";
import {
  CREW_LAUNCH_REPORT_WINDOW_MS,
  CrewLaunchReporter,
  manualLayer as reporterLayer,
} from "./CrewLaunchReporter.ts";
import { crewSeatBriefMessageId, crewSeatThreadId } from "./crewSeatIds.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:launch-report");
const captainThread = ThreadId.make("thread:captain");
const captainId = ParticipantId.make("agent:j5:a2a:thread:captain");
const createdAt = DateTime.makeUnsafe("2026-09-17T20:00:00.000Z");
const at = DateTime.formatIso(createdAt);

type RunFacts = {
  readonly status: OrchestrationV2Run["status"];
  readonly userMessageId: string;
  readonly failure?: { readonly class: string; readonly message: string } | undefined;
};

const projection = (threadId: ThreadId, runs: ReadonlyArray<RunFacts>) =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:launch-report"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      archivedAt: null,
      createdAt,
    },
    runs: runs.map((run, index) => ({
      id: RunId.make(`run:${threadId}:${index}`),
      threadId,
      status: run.status,
      userMessageId: run.userMessageId,
    })),
    turnItems: runs.flatMap((run, index) =>
      run.failure === undefined
        ? []
        : [
            {
              runId: RunId.make(`run:${threadId}:${index}`),
              type: "error",
              status: "failed",
              failure: { ...run.failure, code: null, retryable: null },
            },
          ],
    ),
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const runEvent = (threadId: ThreadId, facts: RunFacts): OrchestrationV2StoredEvent =>
  ({
    sequence: 1,
    commandId: null,
    event: {
      type: "run.updated",
      threadId,
      payload: {
        id: RunId.make(`run:${threadId}:event`),
        threadId,
        status: facts.status,
        userMessageId: facts.userMessageId,
      },
    },
  }) as unknown as OrchestrationV2StoredEvent;

const seat = (name: string, agentId: string) => ({ seat: name, agentId, reason: `${name} works` });

const fixture = Effect.gen(function* () {
  const database = NodeSqliteClient.layerMemory();
  const storage = Layer.mergeAll(crewInstanceLayer, proposalStoreLayer, ledgerLayer).pipe(
    Layer.provideMerge(database),
  );
  const context = yield* Layer.build(storage);
  yield* runJ5A2AMigrations().pipe(Effect.provide(context));
  yield* Effect.provide(
    Effect.gen(function* () {
      yield* (yield* A2ALedger).createSquadron({
        squadron: { id: squadronId, name: "Launch Report Squadron", createdAt: at },
      });
    }),
    context,
  );
  const threads = yield* Ref.make<ReadonlyMap<string, OrchestrationV2ThreadProjection>>(
    new Map([[captainThread, projection(captainThread, [])]]),
  );
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
  // Each dispatch is also a receipt, so a test waits on the report rather than on the clock.
  const receipts = yield* Queue.unbounded<OrchestrationV2Command>();
  const layer = reporterLayer.pipe(
    Layer.provideMerge(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.gen(function* () {
            const found = (yield* Ref.get(threads)).get(threadId);
            if (found === undefined)
              return yield* new OrchestratorProjectionError({
                threadId,
                cause: new ProjectionStoreThreadNotFoundError({ threadId }),
              });
            return found;
          }),
        dispatch: (command) =>
          Ref.update(dispatched, (items) => [...items, command]).pipe(
            Effect.andThen(Queue.offer(receipts, command)),
            Effect.as({ events: [], effects: [] } as never),
          ),
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provideMerge(NodeServices.layer),
  );
  const proposals = Context.get(context, AgentCrewProposalService);
  const crews = Context.get(context, AgentCrewInstanceService);

  /** An approved proposal with its Crew recorded, the way the gate leaves them before the report. */
  const approvedLaunch = (input: {
    readonly id: string;
    readonly requested: ReadonlyArray<ReturnType<typeof seat>>;
    readonly approved: ReadonlyArray<ReturnType<typeof seat>>;
  }) =>
    Effect.gen(function* () {
      const crewId = `crew:${input.id}`;
      yield* proposals.create({
        id: input.id,
        squadronId,
        captainParticipantId: captainId,
        captainThreadId: captainThread,
        crewInstanceId: null,
        kind: "roster",
        brief: "Tell two jokes.",
        displayName: "Comedy",
        requestedSeats: input.requested,
        createdAt: at,
      });
      yield* proposals.claim({ id: input.id, decision: "approve", approvedSeats: input.approved });
      yield* crews.record({
        id: crewId,
        squadronId,
        captainParticipantId: captainId,
        captainThreadId: captainThread,
        displayName: "Comedy",
        brief: "Tell two jokes.",
        createdAt: at,
        members: input.approved.map((entry) => {
          const threadId = crewSeatThreadId(input.id, entry.seat);
          return {
            seatName: entry.seat,
            agentId: entry.agentId,
            participantId: participantIdForThread(threadId),
            threadId,
            reason: entry.reason,
          };
        }),
      });
      yield* proposals.complete({
        id: input.id,
        decision: "approve",
        crewInstanceId: crewId,
        resolvedAt: at,
      });
      return crewId;
    });
  const setSeat = (proposalId: string, seatName: string, runs: ReadonlyArray<RunFacts>) =>
    Ref.update(threads, (map) => {
      const threadId = crewSeatThreadId(proposalId, seatName);
      return new Map(map).set(threadId, projection(threadId, runs));
    });
  const reports = () =>
    Ref.get(dispatched).pipe(
      Effect.map((commands) =>
        commands.flatMap((command) =>
          command.type === "message.dispatch" && command.threadId === captainThread
            ? [command.text]
            : [],
        ),
      ),
    );
  return { layer, proposals, approvedLaunch, setSeat, reports, receipts };
});

it.effect("posts one report once every seat has started or failed, with the run's error", () =>
  Effect.gen(function* () {
    const { layer, proposals, approvedLaunch, setSeat, reports } = yield* fixture;
    const id = "proposal:comedy";
    const requested = [seat("setup", "scout"), seat("punchline", "advocate")];
    const approved = [...requested, seat("prosecutor", "prosecutor")];
    yield* approvedLaunch({ id, requested, approved });
    const brief = (name: string) => crewSeatBriefMessageId(id, name);
    // What the seat threads already show when the watch starts: one running, one dead on its
    // provider, one whose first turn has not been created yet.
    yield* setSeat(id, "setup", [{ status: "running", userMessageId: brief("setup") }]);
    yield* setSeat(id, "punchline", [
      {
        status: "failed",
        userMessageId: brief("punchline"),
        failure: { class: "provider_error", message: "API Error: Can't reach the API server" },
      },
    ]);
    yield* Effect.gen(function* () {
      const reporter = yield* CrewLaunchReporter;
      yield* reporter.watch(id);
      assert.deepStrictEqual(yield* reports(), []);
      // A queued first turn is not a verdict; the report waits.
      const queued = runEvent(crewSeatThreadId(id, "prosecutor"), {
        status: "queued",
        userMessageId: brief("prosecutor"),
      });
      assert.isNull(yield* reporter.handleStoredEvent(queued));
      const punchlineRun = {
        id: RunId.make("run:x"),
        threadId: crewSeatThreadId(id, "punchline"),
        userMessageId: brief("punchline"),
        status: "failed",
      } as unknown as OrchestrationV2Run;
      assert.isTrue(yield* reporter.coversFailure(crewSeatThreadId(id, "punchline"), punchlineRun));
      // The last seat opens its turn: the report posts, once, with every verdict.
      const running = runEvent(crewSeatThreadId(id, "prosecutor"), {
        status: "running",
        userMessageId: brief("prosecutor"),
      });
      assert.equal(yield* reporter.handleStoredEvent(running), id);
      const [report] = yield* reports();
      assert.isDefined(report);
      assert.include(report!, "launch: 2 started, 1 failed to start, 0 not started after 60s");
      assert.include(report!, "changes: added prosecutor");
      assert.include(
        report!,
        "seat_failed: punchline | failed | provider_error — API Error: Can't reach the API server",
      );
      assert.include(report!, `thread_id=${crewSeatThreadId(id, "setup")} start=started`);
      assert.include(report!, `thread_id=${crewSeatThreadId(id, "prosecutor")} start=started`);
      assert.isNotNull((yield* proposals.read(id))!.reportedAt);
      // Replayed or late events post nothing more, and the seat's failure is no longer covered.
      assert.isNull(yield* reporter.handleStoredEvent(running));
      assert.isFalse(
        yield* reporter.coversFailure(crewSeatThreadId(id, "punchline"), punchlineRun),
      );
      assert.lengthOf(yield* reports(), 1);
      // Watching again finds nothing pending and posts nothing: the report is idempotent.
      yield* reporter.watch(id);
      assert.lengthOf(yield* reports(), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect(
  "the window closes on a seat that never starts, and the boot sweep catches a lost report",
  () =>
    Effect.gen(function* () {
      const { layer, proposals, approvedLaunch, setSeat, reports, receipts } = yield* fixture;
      const slow = "proposal:slow";
      yield* approvedLaunch({
        id: slow,
        requested: [seat("setup", "scout")],
        approved: [seat("setup", "scout")],
      });
      // A launch approved before a restart whose seat already started: the sweep reports it at once.
      const lost = "proposal:lost";
      yield* approvedLaunch({
        id: lost,
        requested: [seat("herald", "herald")],
        approved: [seat("herald", "herald")],
      });
      yield* setSeat(lost, "herald", [
        { status: "completed", userMessageId: crewSeatBriefMessageId(lost, "herald") },
      ]);
      yield* Effect.gen(function* () {
        const reporter = yield* CrewLaunchReporter;
        assert.sameMembers([...(yield* reporter.reconcile)], [slow, lost]);
        yield* Queue.take(receipts);
        let texts = yield* reports();
        assert.lengthOf(texts, 1);
        assert.include(texts[0]!, `proposal_id: ${lost}`);
        assert.include(texts[0]!, "launch: 1 started, 0 failed to start, 0 not started after 60s");
        assert.isNotNull((yield* proposals.read(lost))!.reportedAt);
        assert.isNull((yield* proposals.read(slow))!.reportedAt);
        // The slow seat's thread never even exists; when the window closes the Captain is told so.
        yield* TestClock.adjust(CREW_LAUNCH_REPORT_WINDOW_MS);
        yield* Queue.take(receipts);
        texts = yield* reports();
        assert.lengthOf(texts, 2);
        assert.include(texts[1]!, `proposal_id: ${slow}`);
        assert.include(texts[1]!, "launch: 0 started, 0 failed to start, 1 not started after 60s");
        assert.include(texts[1]!, "seat_pending: setup");
        assert.include(texts[1]!, "1 seat had not started after 60s");
        assert.isNotNull((yield* proposals.read(slow))!.reportedAt);
        // Nothing is left for a second sweep.
        assert.deepStrictEqual(yield* reporter.reconcile, []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
