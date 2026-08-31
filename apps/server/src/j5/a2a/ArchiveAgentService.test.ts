import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../../auth/utils.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  ArchiveAgentConfirmationRequiredError,
  ArchiveAgentConfirmationStaleError,
  ArchiveAgentConfirmationTokenError,
  ArchiveAgentPartialFailureError,
  ArchiveAgentService,
  ArchiveAgentTargetMismatchError,
  layer as archiveAgentLayer,
  type ArchiveAgentInput,
} from "./ArchiveAgentService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import { A2ALedger } from "./LedgerService.ts";
import { A2ALifecycleCounterpartyStateError, A2ALifecycleService } from "./LifecycleService.ts";
import {
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
  type StoredCommEvent,
} from "./contracts.ts";

const squadronId = SquadronId.make("squadron:archive-agent");
const exchangeSquadronId = SquadronId.make("squadron:archive-agent:counterparty");
const participantId = ParticipantId.make("agent:archive-agent:target");
const counterpartyId = ParticipantId.make("agent:archive-agent:counterparty");
const callerParticipantId = ParticipantId.make("agent:archive-agent:caller");
const threadId = ThreadId.make("thread:archive-agent:target");
const projectId = ProjectId.make("project:archive-agent");
const runId = RunId.make("run:archive-agent:target");
const exchangeId = ExchangeId.make("exchange:archive-agent:open");
const now = "2026-08-31T18:00:00.000Z";
const nowUtc = DateTime.makeUnsafe(now);
const signingSecret = new Uint8Array(32).fill(19);

const target = { squadronId, participantId, threadId } as const;

const archiveInput = (confirmationToken?: string): ArchiveAgentInput => ({
  providerSessionId: "provider-session:archive-agent",
  callerParticipantId,
  target,
  clientRequestKey: "archive-agent-request",
  ...(confirmationToken === undefined ? {} : { confirmationToken }),
  archivedAt: now,
  interruptCommandId: CommandId.make("command:archive-agent:interrupt"),
  archiveCommandId: CommandId.make("command:archive-agent:thread"),
});

interface HarnessOptions {
  readonly openExchange?: boolean;
  readonly exchangeSquadronId?: SquadronId;
  readonly runStatus?: OrchestrationV2RunStatus;
  readonly mismatchParticipantId?: ParticipantId;
  readonly failLifecycleOnce?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) => {
  let archived = false;
  let retired = false;
  let open = options.openExchange ?? false;
  let runStatus = options.runStatus;
  let lifecycleCalls = 0;
  let archiveCalls = 0;
  let factReads = 0;
  const owningExchangeSquadronId = options.exchangeSquadronId ?? squadronId;
  const order: Array<string> = [];
  const events: Array<StoredCommEvent> = [];
  const nextSeq = (eventSquadronId: SquadronId) =>
    events.filter((event) => event.squadronId === eventSquadronId).length + 1;

  const projection = (): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: threadId,
        projectId,
        archivedAt: archived ? nowUtc : null,
      },
      runs:
        runStatus === undefined
          ? []
          : [
              {
                id: runId,
                status: runStatus,
                ordinal: 1,
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            ],
    }) as unknown as OrchestrationV2ThreadProjection;

  const appendParticipantLeft = () => {
    if (events.some((event) => event.kind === "participant.left")) return;
    events.push({
      seq: nextSeq(squadronId),
      squadronId,
      kind: "participant.left",
      sender: null,
      receiver: participantId,
      exchangeId: null,
      correlationId: null,
      payload: { participant: { kind: "agent", id: participantId, threadId } },
      createdAt: now,
    });
  };

  const appendClosure = () => {
    appendParticipantLeft();
    if (!open) return;
    const correlationId = CorrelationId.make("correlation:archive-agent:open");
    const noticeMessageId = LedgerMessageId.make("message:archive-agent:terminal");
    const firstSeq = nextSeq(owningExchangeSquadronId);
    events.push(
      {
        seq: firstSeq,
        squadronId: owningExchangeSquadronId,
        kind: "exchange.dropped",
        sender: participantId,
        receiver: counterpartyId,
        exchangeId,
        correlationId,
        payload: {
          disposition: "sender-retired",
          cause: { kind: "participant-archived", participantId, squadronId },
          facts: {
            replyRequired: false,
            retryAllowed: false,
            replacementRequired: false,
          },
          noticeMessageId,
        },
        createdAt: now,
      },
      {
        seq: firstSeq + 1,
        squadronId: owningExchangeSquadronId,
        kind: "message.sent",
        sender: ParticipantId.make("agent:platform:lifecycle"),
        receiver: counterpartyId,
        exchangeId,
        correlationId,
        payload: {
          messageId: noticeMessageId,
          text: "Lifecycle terminal notice",
          originSquadronId: owningExchangeSquadronId,
          receiverSquadronId: squadronId,
          exchangeRole: "terminal_notice",
          envelopeChannel: "lifecycle_notice",
        },
        createdAt: now,
      },
    );
    open = false;
  };

  const dependencies = Layer.mergeAll(
    Layer.succeed(
      A2AArchiveFacts,
      A2AArchiveFacts.of({
        readForThread: () => {
          factReads += 1;
          return Effect.succeed({
            state: "registered",
            threadId,
            squadronId,
            participantId: options.mismatchParticipantId ?? participantId,
            retired,
            openExchanges: open
              ? [
                  {
                    squadronId: owningExchangeSquadronId,
                    exchangeId,
                    direction: "outbound",
                    replyObligation: "counterparty-owes-reply",
                    counterpartyId,
                    intent: "Finish the archive review",
                    urgency: "blocking",
                    openedAt: now,
                  },
                ]
              : [],
            placementSubtree: { state: "none" },
          });
        },
      }),
    ),
    Layer.mock(A2ALedger)({
      listSquadrons: () =>
        Effect.succeed(
          [...new Set([squadronId, owningExchangeSquadronId])].map((id) => ({
            id,
            name: id,
            createdAt: now,
          })),
        ),
      readEvents: ({ squadronId: requestedSquadronId }) => {
        const matching = events.filter((event) => event.squadronId === requestedSquadronId);
        return Effect.succeed({
          events: matching,
          nextCursor: { afterSeq: matching.length, snapshotEnd: matching.length },
          complete: true,
        });
      },
    }),
    Layer.mock(ThreadManagementService)({
      getThreadProjection: () => Effect.succeed(projection()),
      interruptThread: () => {
        order.push("interrupt_requested");
        return Effect.succeed({
          type: "interrupt_requested",
          run: projection().runs[0]!,
          dispatch: { sequence: 1, storedEvents: [] },
        });
      },
    }),
    Layer.mock(ThreadLifecycleService)({
      archive: () => {
        archiveCalls += 1;
        order.push("thread_archive_committed");
        archived = true;
        return Effect.succeed(projection());
      },
    }),
    Layer.mock(A2ALifecycleService)({
      archiveParticipant: () => {
        lifecycleCalls += 1;
        retired = true;
        appendParticipantLeft();
        if (options.failLifecycleOnce === true && lifecycleCalls === 1) {
          return Effect.fail(
            new A2ALifecycleCounterpartyStateError({ participantId: counterpartyId, exchangeId }),
          );
        }
        const hadOpenExchange = open;
        appendClosure();
        order.push("lifecycle_obligations_committed");
        return Effect.succeed({
          archived: lifecycleCalls === 1,
          droppedExchangeIds: hadOpenExchange ? [exchangeId] : [],
        });
      },
    }),
    Layer.mock(ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(signingSecret),
    }),
  );

  return {
    layer: archiveAgentLayer.pipe(Layer.provide(dependencies)),
    snapshot: () => ({
      archived,
      retired,
      open,
      runStatus,
      lifecycleCalls,
      archiveCalls,
      factReads,
      order,
      events,
    }),
    settleRun: () => {
      runStatus = "interrupted";
    },
  };
};

it.effect("archives a clean exact target and proves terminal ledger facts on replay", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* ArchiveAgentService;
    assert.equal(yield* service.archive(archiveInput()), "archived");
    assert.equal(yield* service.archive(archiveInput()), "already_archived");
    const state = harness.snapshot();
    assert.isTrue(state.archived);
    assert.isTrue(state.retired);
    assert.equal(state.archiveCalls, 1);
    assert.equal(state.lifecycleCalls, 1);
    assert.isTrue(state.events.some((event) => event.kind === "participant.left"));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("closes cross-Squadron consequences before returning archived", () => {
  const harness = makeHarness({
    openExchange: true,
    exchangeSquadronId,
    runStatus: "running",
  });
  return Effect.gen(function* () {
    const service = yield* ArchiveAgentService;
    const refusal = yield* Effect.flip(service.archive(archiveInput()));
    assert.instanceOf(refusal, ArchiveAgentConfirmationRequiredError);
    if (!(refusal instanceof ArchiveAgentConfirmationRequiredError)) return;
    assert.deepStrictEqual(
      refusal.facts.openExchanges.map((fact) => fact.exchangeId),
      [exchangeId],
    );
    assert.deepStrictEqual(refusal.facts.runningTurn, { runId, status: "running" });

    assert.equal(yield* service.archive(archiveInput(refusal.confirmationToken)), "archived");
    assert.equal(
      yield* service.archive(archiveInput(refusal.confirmationToken)),
      "already_archived",
    );
    const state = harness.snapshot();
    assert.deepStrictEqual(state.order, [
      "interrupt_requested",
      "thread_archive_committed",
      "lifecycle_obligations_committed",
    ]);
    assert.equal(state.runStatus, "running");
    assert.isTrue(state.events.some((event) => event.kind === "exchange.dropped"));
    assert.isTrue(
      state.events.some(
        (event) =>
          event.kind === "message.sent" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "exchangeRole" in event.payload &&
          event.payload.exchangeRole === "terminal_notice",
      ),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects malformed and unknown-version tokens before reading target facts", () => {
  const malformedHarness = makeHarness({ openExchange: true });
  const unknownHarness = makeHarness({ openExchange: true });
  const encoded = base64UrlEncode('{"version":"j5-archive-confirmation/v2"}');
  const unknownVersionToken = `${encoded}.${signPayload(encoded, signingSecret)}`;
  return Effect.gen(function* () {
    const malformed = yield* Effect.gen(function* () {
      return yield* Effect.flip((yield* ArchiveAgentService).archive(archiveInput("not-a-token")));
    }).pipe(Effect.provide(malformedHarness.layer));
    assert.instanceOf(malformed, ArchiveAgentConfirmationTokenError);
    if (malformed instanceof ArchiveAgentConfirmationTokenError) {
      assert.equal(malformed.reason, "malformed");
    }
    assert.equal(malformedHarness.snapshot().factReads, 0);

    const unknown = yield* Effect.gen(function* () {
      return yield* Effect.flip(
        (yield* ArchiveAgentService).archive(archiveInput(unknownVersionToken)),
      );
    }).pipe(Effect.provide(unknownHarness.layer));
    assert.instanceOf(unknown, ArchiveAgentConfirmationTokenError);
    if (unknown instanceof ArchiveAgentConfirmationTokenError) {
      assert.equal(unknown.reason, "unsupported-version");
    }
    assert.equal(unknownHarness.snapshot().factReads, 0);
  });
});

it.effect("refuses an X-for-Y target mismatch before interrupt, archive, or closure", () => {
  const harness = makeHarness({
    mismatchParticipantId: ParticipantId.make("agent:archive-agent:other"),
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip((yield* ArchiveAgentService).archive(archiveInput()));
    assert.instanceOf(error, ArchiveAgentTargetMismatchError);
    const state = harness.snapshot();
    assert.equal(state.archiveCalls, 0);
    assert.equal(state.lifecycleCalls, 0);
    assert.deepStrictEqual(state.order, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a stale token after consequential target facts change", () => {
  const harness = makeHarness({ openExchange: true, runStatus: "running" });
  return Effect.gen(function* () {
    const service = yield* ArchiveAgentService;
    const refusal = yield* Effect.flip(service.archive(archiveInput()));
    assert.instanceOf(refusal, ArchiveAgentConfirmationRequiredError);
    if (!(refusal instanceof ArchiveAgentConfirmationRequiredError)) return;

    harness.settleRun();
    const stale = yield* Effect.flip(service.archive(archiveInput(refusal.confirmationToken)));
    assert.instanceOf(stale, ArchiveAgentConfirmationStaleError);
    if (stale instanceof ArchiveAgentConfirmationStaleError) {
      assert.isNotNull(stale.confirmationToken);
      assert.isNull(stale.facts.runningTurn);
      assert.deepStrictEqual(
        stale.facts.openExchanges.map((fact) => fact.exchangeId),
        [exchangeId],
      );
    }
    const state = harness.snapshot();
    assert.equal(state.archiveCalls, 0);
    assert.equal(state.lifecycleCalls, 0);
    assert.deepStrictEqual(state.order, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("recovers forward after a committed thread archive and incomplete notice set", () => {
  const harness = makeHarness({
    openExchange: true,
    runStatus: "running",
    failLifecycleOnce: true,
  });
  return Effect.gen(function* () {
    const service = yield* ArchiveAgentService;
    const refusal = yield* Effect.flip(service.archive(archiveInput()));
    assert.instanceOf(refusal, ArchiveAgentConfirmationRequiredError);
    if (!(refusal instanceof ArchiveAgentConfirmationRequiredError)) return;

    const partial = yield* Effect.flip(service.archive(archiveInput(refusal.confirmationToken)));
    assert.instanceOf(partial, ArchiveAgentPartialFailureError);
    if (partial instanceof ArchiveAgentPartialFailureError) {
      assert.isTrue(partial.interruptRequested);
      assert.isTrue(partial.threadArchived);
      assert.isTrue(partial.participantRetired);
      assert.deepStrictEqual(partial.pendingExchangeIds, [exchangeId]);
      assert.deepStrictEqual(partial.runningTurn, { runId, status: "running" });
    }

    assert.equal(yield* service.archive(archiveInput(refusal.confirmationToken)), "archived");
    const state = harness.snapshot();
    assert.equal(state.archiveCalls, 1);
    assert.equal(state.lifecycleCalls, 2);
    assert.isFalse(state.open);
  }).pipe(Effect.provide(harness.layer));
});
