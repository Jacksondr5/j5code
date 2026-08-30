/**
 * Dev-only disposable A2A delivery seed support.
 *
 * A6 multi-statement-truncation lesson: never seed this flow with a raw
 * multi-statement SQL string. Each scenario's durable state uses production
 * services in one transaction, so it either has a complete receipt or rolls
 * back. Run only while the target T3 server is stopped; this process owns the
 * one database accessor and exits completely after printing its receipt.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { homedir } from "node:os";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../../mcp/McpSessionRegistry.testkit.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
} from "../../../orchestration-v2/runtimeLayer.ts";
import {
  EffectOutboxV2,
  layer as effectOutboxLayer,
} from "../../../orchestration-v2/EffectOutbox.ts";
import {
  isActiveRun,
  latestActiveRun,
  ThreadManagementService,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import type { ProviderAdapterV2Shape } from "../../../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  deliveryCommandId,
  deliveryMessageId,
  live as deliveryTransportLayer,
} from "../DeliveryTransport.ts";
import { manualLayer as deliveryWorkerLayer, A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "../LedgerService.ts";
import { A2ASendService, layer as sendServiceLayer } from "../SendService.ts";
import { A2ASilenceDetector, manualLayer as silenceDetectorLayer } from "../SilenceDetector.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  SquadronId,
} from "../contracts.ts";

const fakeProviderInstanceId = ProviderInstanceId.make("j5-dev-seed-unavailable");
const fakeModelSelection = {
  instanceId: fakeProviderInstanceId,
  model: "j5-dev-seed-unavailable",
} satisfies ModelSelection;
const fakeDriver = ProviderDriverKind.make("codex");

export interface DevDeliverySeedReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly baseDir: string;
  readonly dbPath: string;
  readonly project: { readonly id: ProjectId };
  readonly threads: {
    readonly sender: { readonly threadId: ThreadId; readonly participantId: ParticipantId };
    readonly receiver: { readonly threadId: ThreadId; readonly participantId: ParticipantId };
  };
  readonly scenarios: {
    readonly ta1PeerExchange: {
      readonly ledgerMessageId: LedgerMessageId;
      readonly deliveryMessageId: MessageId;
      readonly exchangeId: ExchangeId;
      readonly targetThreadId: ThreadId;
    };
    readonly ta3Silence: {
      readonly sourceLedgerMessageId: LedgerMessageId;
      readonly sourceDeliveryMessageId: MessageId;
      readonly noticeLedgerMessageId: LedgerMessageId;
      readonly noticeDeliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly rawFutureEnvelope: {
      readonly ledgerMessageId: LedgerMessageId;
      readonly deliveryMessageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
    readonly normalNonA2AContrast: {
      readonly messageId: MessageId;
      readonly targetThreadId: ThreadId;
    };
  };
  readonly noProviderWork: {
    readonly runnerStartedEffectWorker: false;
    readonly providerAdapterOpenSessionCalls: 0;
    readonly activeProviderSessionCount: 0;
    readonly activeRunCount: 0;
    readonly cancelledProviderStartEffectCount: number;
    readonly nextClaimableAt: null;
  };
  readonly notSeeded: {
    readonly ta2HumanAnswer: {
      readonly status: "requires-post-rebase-merged-human-inbox";
      readonly reason: "TA2 must use the merged #11 HumanInbox production flow; this runner does not fabricate a thread row.";
    };
    readonly ta4Trailing: {
      readonly status: "held";
      readonly reason: "TA4 remains behind its separately authorized timeline seam.";
    };
  };
  readonly reuse: {
    readonly invocation: "scripts/j5/a2a-delivery-seed.sh --base-dir <isolated-t3-home>";
    readonly note: "Use the receipt ids to locate only this disposable seed set; rerunning creates a new run id.";
  };
}

export class DevDeliverySeedArgumentError extends Error {}

export class DevDeliverySeedServerOffError extends Error {
  constructor(cause: unknown) {
    super(
      "The disposable A2A seed runner could not acquire its rollback write preflight. Stop the target T3 server, confirm no process holds this isolated database, then retry.",
      { cause },
    );
  }
}

class DevDeliverySeedPreflightRollback extends Error {}

export const parseDevDeliverySeedArgs = (args: ReadonlyArray<string>) => {
  if (args.length !== 2 || args[0] !== "--base-dir") {
    throw new DevDeliverySeedArgumentError("Usage: --base-dir <absolute isolated T3 home>");
  }
  return { baseDir: args[1]! };
};

const isInside = (candidate: string, parent: string) => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/** Require an existing, absolute disposable T3 home; resolves symlinks before rejecting live state. */
export const validateIsolatedBaseDir = (baseDir: string) => {
  if (!isAbsolute(baseDir)) {
    throw new DevDeliverySeedArgumentError("--base-dir must be an absolute path.");
  }
  const requested = resolve(baseDir);
  const configuredSharedT3Home = resolve(homedir(), ".t3");
  const sharedT3Home = existsSync(configuredSharedT3Home)
    ? realpathSync(configuredSharedT3Home)
    : configuredSharedT3Home;
  let existingParent = requested;
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  if (isInside(requested, sharedT3Home) || isInside(realpathSync(existingParent), sharedT3Home)) {
    throw new DevDeliverySeedArgumentError(
      "--base-dir must not be ~/.t3 or anything below it, including ~/.t3/userdata.",
    );
  }
  mkdirSync(requested, { recursive: true });
  const resolvedBaseDir = realpathSync(requested);
  if (isInside(resolvedBaseDir, sharedT3Home)) {
    throw new DevDeliverySeedArgumentError(
      "--base-dir must not be ~/.t3 or anything below it, including ~/.t3/userdata.",
    );
  }
  return resolvedBaseDir;
};

const databasePathFor = (baseDir: string) => resolve(baseDir, "userdata", "state.sqlite");

const seededId = (runId: string, suffix: string) => `${runId}:${suffix}`;

const isDatabaseContention = (cause: unknown) =>
  /SQLITE_BUSY|database is locked|database is busy/i.test(
    `${String(cause)} ${cause instanceof Error ? String(cause.cause) : ""}`,
  );

const unavailableAdapter: ProviderAdapterV2Shape = {
  instanceId: fakeProviderInstanceId,
  driver: fakeDriver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  // The runner never starts an effect worker. A call here proves that boundary was broken.
  openSession: () =>
    Effect.die("The disposable A2A seed runner must never open a provider session."),
};

const makeRuntimeLayer = (baseDir: string) => {
  const database = makeSqlitePersistenceLive(databasePathFor(baseDir)).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  const vcs = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  const checkpoint = CheckpointStore.layer.pipe(Layer.provide(vcs));
  const fakeProvider: ProviderInstance = {
    instanceId: fakeProviderInstanceId,
    driverKind: fakeDriver,
    continuationIdentity: {
      driverKind: fakeDriver,
      continuationKey: "j5-dev-seed-unavailable",
    },
    displayName: "J5 disposable seed unavailable provider",
    enabled: false,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: unavailableAdapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  const providers = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === fakeProviderInstanceId ? fakeProvider : undefined),
    listInstances: Effect.succeed([fakeProvider]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  // This assembles command/persistence services only. No effect worker is started and the
  // sole provider is deliberately unavailable; every seeded run is interrupted before exit.
  const orchestration = Layer.merge(
    OrchestrationV2LayerLive,
    OrchestrationV2EventSinkLayerLive,
  ).pipe(
    Layer.provide(mcpSessionRegistryTestLayer),
    Layer.provide(checkpoint),
    Layer.provide(config),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(providers),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(database),
  );
  const deliveryWorker = deliveryWorkerLayer.pipe(Layer.provideMerge(deliveryTransportLayer));
  const silenceDetector = silenceDetectorLayer.pipe(Layer.provideMerge(deliveryWorker));
  const a2a = Layer.mergeAll(sendServiceLayer, deliveryWorker, silenceDetector).pipe(
    Layer.provideMerge(ledgerLayer),
    Layer.provide(orchestration),
  );
  // Reuse the same outbox layer reference as the V2 event sink so the receipt
  // can prove each provider-start effect is cancelled before this process exits.
  const exposedOutbox = effectOutboxLayer.pipe(Layer.provide(database));
  return Layer.mergeAll(orchestration, a2a, exposedOutbox);
};

const readAllEvents = (squadronId: SquadronId) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    return (yield* ledger.readEvents({ squadronId, cursor: { afterSeq: 0 }, limit: 1_000 })).events;
  });

const deliveredEventFor = (squadronId: SquadronId, messageId: LedgerMessageId) =>
  readAllEvents(squadronId).pipe(
    Effect.flatMap((events) => {
      const delivered = events.find(
        (event) =>
          event.kind === "message.delivered" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "messageId" in event.payload &&
          event.payload.messageId === messageId,
      );
      return delivered === undefined
        ? Effect.die(`No delivery receipt was recorded for ${messageId}.`)
        : Effect.succeed(delivered);
    }),
  );

const interruptActiveSeedRun = (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
}) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const before = yield* threads.getThreadProjection(input.threadId);
    const active = latestActiveRun(before);
    if (active === undefined) {
      return yield* Effect.die(`Seed delivery did not create an active run for ${input.threadId}.`);
    }
    const result = yield* threads.interruptThread({
      projectId: input.projectId,
      threadId: input.threadId,
      runId: active.id,
      commandId: input.commandId,
      reason: "Disposable A2A seed: cancel before any provider effect can run.",
    });
    if (result.type !== "interrupt_requested") {
      return yield* Effect.die(`Expected to interrupt seed run ${active.id}.`);
    }
    const after = yield* threads.getThreadProjection(input.threadId);
    const run = after.runs.find((candidate) => candidate.id === active.id);
    if (run?.status !== "interrupted" || after.providerSessions.length !== 0) {
      return yield* Effect.die(
        `Seed run ${active.id} was not terminal without a provider session.`,
      );
    }
    return active.id;
  });

const atomicScenario = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`Disposable seed scenario ${name} rolled back.`, { cause }),
        ),
      ),
  );

/**
 * Takes and rolls back a real production-ledger write before any scenario.
 * A busy DB reaches the caller as a clear server-off precondition failure.
 */
const assertTargetServerStopped = (input: {
  readonly squadronId: SquadronId;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* A2ALedger;
    yield* sql
      .withTransaction(
        ledger
          .createSquadron({
            squadron: {
              id: input.squadronId,
              name: `J5 disposable server-off preflight ${input.squadronId}`,
              createdAt: input.createdAt,
            },
          })
          .pipe(Effect.andThen(Effect.fail(new DevDeliverySeedPreflightRollback()))),
      )
      .pipe(
        Effect.catch((cause) =>
          cause instanceof DevDeliverySeedPreflightRollback
            ? Effect.void
            : Effect.fail(new DevDeliverySeedServerOffError(cause)),
        ),
      );
  });

const joinScenarioAgents = (input: {
  readonly squadronId: SquadronId;
  readonly senderId: ParticipantId;
  readonly senderThreadId: ThreadId;
  readonly receiverId: ParticipantId;
  readonly receiverThreadId: ThreadId;
  readonly acceptedAt: string;
  readonly commandId: CommCommandId;
}) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    yield* ledger.appendEvents({
      commandId: input.commandId,
      squadronId: input.squadronId,
      acceptedAt: input.acceptedAt,
      events: [
        {
          kind: "participant.joined",
          sender: null,
          receiver: input.senderId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: input.senderId, threadId: input.senderThreadId },
          },
          createdAt: input.acceptedAt,
        },
        {
          kind: "participant.joined",
          sender: null,
          receiver: input.receiverId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: input.receiverId, threadId: input.receiverThreadId },
          },
          createdAt: input.acceptedAt,
        },
      ],
    });
  });

export const runDevDeliverySeed = (requestedBaseDir: string) =>
  Effect.gen(function* () {
    const baseDir = validateIsolatedBaseDir(requestedBaseDir);
    const runId = `j5-a2a-seed-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const projectId = ProjectId.make(`project:${runId}`);
    const senderThreadId = ThreadId.make(`thread:${runId}:sender`);
    const receiverThreadId = ThreadId.make(`thread:${runId}:receiver`);
    const senderId = ParticipantId.make(`agent:${runId}:sender`);
    const receiverId = ParticipantId.make(`agent:${runId}:receiver`);
    const squadronId = SquadronId.make(`squadron:${runId}`);
    const runtime = makeRuntimeLayer(baseDir);

    const seed = Effect.gen(function* () {
      const threads = yield* ThreadManagementService;
      const ledger = yield* A2ALedger;
      const sender = yield* A2ASendService;
      const deliveries = yield* A2ADeliveryWorker;
      const silence = yield* A2ASilenceDetector;
      const outbox = yield* EffectOutboxV2;

      yield* assertTargetServerStopped({
        squadronId: SquadronId.make(seededId(runId, "server-off-preflight")),
        createdAt: now,
      });

      yield* atomicScenario(
        "bootstrap",
        Effect.gen(function* () {
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(seededId(runId, "bootstrap:sender-thread")),
            threadId: senderThreadId,
            projectId,
            title: "J5 disposable A2A sender seed",
            modelSelection: fakeModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            createdBy: "system",
            creationSource: "server",
          });
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(seededId(runId, "bootstrap:receiver-thread")),
            threadId: receiverThreadId,
            projectId,
            title: "J5 disposable A2A receiver seed",
            modelSelection: fakeModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            createdBy: "system",
            creationSource: "server",
          });
          yield* ledger.createSquadron({
            squadron: { id: squadronId, name: `J5 disposable A2A ${runId}`, createdAt: now },
          });
          yield* joinScenarioAgents({
            squadronId,
            senderId,
            senderThreadId,
            receiverId,
            receiverThreadId,
            acceptedAt: now,
            commandId: CommCommandId.make(seededId(runId, "bootstrap:membership")),
          });
        }),
      );

      const ta1 = yield* atomicScenario(
        "ta1-peer-exchange",
        Effect.gen(function* () {
          const result = yield* sender.send({
            commandId: CommCommandId.make(seededId(runId, "ta1:send")),
            senderThreadId,
            to: receiverId,
            message: "Peer delivery seed: please reply through this exchange.",
            expectReply: true,
            intent: "Seed a visible peer exchange.",
            acceptedAt: now,
          });
          if (result.exchangeId === null)
            return yield* Effect.die("TA1 seed did not open an exchange.");
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "ta1:cancel-provider-start")),
          });
          return {
            ledgerMessageId: result.messageId,
            deliveryMessageId: deliveryMessageId(result.messageId),
            exchangeId: result.exchangeId,
            targetThreadId: receiverThreadId,
          };
        }),
      );

      const ta3 = yield* atomicScenario(
        "ta3-silence",
        Effect.gen(function* () {
          const source = yield* sender.send({
            commandId: CommCommandId.make(seededId(runId, "ta3:send")),
            senderThreadId,
            to: receiverId,
            message: "Silence seed: this delivery will end before a reply.",
            expectReply: true,
            intent: "Seed a truthful silence notice.",
            acceptedAt: now,
          });
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "ta3:cancel-provider-start")),
          });
          const delivered = yield* deliveredEventFor(squadronId, source.messageId);
          const notices = yield* silence.handleDeliveryEvent(delivered);
          const notice = notices[0];
          if (notice?.kind !== "silence.notice") {
            return yield* Effect.die("TA3 seed did not produce a silence notice.");
          }
          const noticeMessageId = LedgerMessageId.make(
            `message:j5:a2a:silence:${encodeURIComponent(squadronId)}:${encodeURIComponent(source.exchangeId!)}:${encodeURIComponent(source.messageId)}`,
          );
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "ta3:cancel-notice-provider-start")),
          });
          return {
            sourceLedgerMessageId: source.messageId,
            sourceDeliveryMessageId: deliveryMessageId(source.messageId),
            noticeLedgerMessageId: noticeMessageId,
            noticeDeliveryMessageId: deliveryMessageId(noticeMessageId),
            targetThreadId: senderThreadId,
          };
        }),
      );

      const rawFutureEnvelope = yield* atomicScenario(
        "raw-future-envelope",
        Effect.gen(function* () {
          const messageId = LedgerMessageId.make(seededId(runId, "raw:future-envelope"));
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(seededId(runId, "raw:future-envelope")),
            squadronId,
            acceptedAt: now,
            events: [
              {
                kind: "message.sent",
                sender: SILENCE_DETECTOR_PARTICIPANT_ID,
                receiver: receiverId,
                exchangeId: null,
                correlationId: CorrelationId.make(seededId(runId, "raw:future-correlation")),
                payload: {
                  messageId,
                  text: "[Cross-agent messaging system notice: template-v999]\n\nThis deliberately future/unrecognized envelope must render as raw text.\n\nNo current renderer template owns this body.",
                  originSquadronId: squadronId,
                  receiverSquadronId: squadronId,
                  exchangeRole: "none",
                  envelopeChannel: "silence_notice",
                },
                createdAt: now,
              },
            ],
          });
          yield* deliveries.drain;
          yield* interruptActiveSeedRun({
            projectId,
            threadId: receiverThreadId,
            commandId: CommandId.make(seededId(runId, "raw:cancel-provider-start")),
          });
          return {
            ledgerMessageId: messageId,
            deliveryMessageId: deliveryMessageId(messageId),
            targetThreadId: receiverThreadId,
          };
        }),
      );

      const normalNonA2AContrast = yield* atomicScenario(
        "normal-non-a2a-contrast",
        Effect.gen(function* () {
          const messageId = MessageId.make(`message:mcp:${runId}:thread-send:contrast`);
          yield* threads.sendToThread({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "normal:mcp-send")),
            messageId,
            text: "Normal MCP-shaped contrast: this must retain the generic timeline row.",
            attachments: [],
            modelSelection: fakeModelSelection,
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* interruptActiveSeedRun({
            projectId,
            threadId: senderThreadId,
            commandId: CommandId.make(seededId(runId, "normal:cancel-provider-start")),
          });
          return { messageId, targetThreadId: senderThreadId };
        }),
      );

      const senderProjection = yield* threads.getThreadProjection(senderThreadId);
      const receiverProjection = yield* threads.getThreadProjection(receiverThreadId);
      const projections = [senderProjection, receiverProjection];
      const activeRunCount = projections
        .flatMap((projection) => projection.runs)
        .filter(isActiveRun).length;
      const activeProviderSessionCount = projections.reduce(
        (total, projection) => total + projection.providerSessions.length,
        0,
      );
      if (activeRunCount !== 0 || activeProviderSessionCount !== 0) {
        return yield* Effect.die("Disposable seed left provider-executable work behind.");
      }
      const effectedCommandIds = [
        deliveryCommandId(ta1.ledgerMessageId),
        deliveryCommandId(ta3.sourceLedgerMessageId),
        deliveryCommandId(ta3.noticeLedgerMessageId),
        deliveryCommandId(rawFutureEnvelope.ledgerMessageId),
        CommandId.make(seededId(runId, "normal:mcp-send")),
      ];
      const persistedEffects = yield* Effect.forEach(
        effectedCommandIds,
        (commandId) => outbox.listByCommandId(commandId),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat()));
      const cancelledProviderStartEffectCount = persistedEffects.filter(
        (effect) => effect.request.type === "provider-turn.start" && effect.status === "cancelled",
      ).length;
      if (cancelledProviderStartEffectCount !== effectedCommandIds.length) {
        return yield* Effect.die("Disposable seed left a provider-turn start effect executable.");
      }
      const nextClaimableAt = yield* outbox.nextClaimableAt;
      if (Option.isSome(nextClaimableAt)) {
        return yield* Effect.die("Disposable seed left a claimable orchestration effect behind.");
      }

      return {
        version: 1,
        runId,
        baseDir,
        dbPath: databasePathFor(baseDir),
        project: { id: projectId },
        threads: {
          sender: { threadId: senderThreadId, participantId: senderId },
          receiver: { threadId: receiverThreadId, participantId: receiverId },
        },
        scenarios: {
          ta1PeerExchange: ta1,
          ta3Silence: ta3,
          rawFutureEnvelope,
          normalNonA2AContrast,
        },
        noProviderWork: {
          runnerStartedEffectWorker: false,
          providerAdapterOpenSessionCalls: 0,
          activeProviderSessionCount,
          activeRunCount,
          cancelledProviderStartEffectCount,
          nextClaimableAt: null,
        },
        notSeeded: {
          ta2HumanAnswer: {
            status: "requires-post-rebase-merged-human-inbox",
            reason:
              "TA2 must use the merged #11 HumanInbox production flow; this runner does not fabricate a thread row.",
          },
          ta4Trailing: {
            status: "held",
            reason: "TA4 remains behind its separately authorized timeline seam.",
          },
        },
        reuse: {
          invocation: "scripts/j5/a2a-delivery-seed.sh --base-dir <isolated-t3-home>",
          note: "Use the receipt ids to locate only this disposable seed set; rerunning creates a new run id.",
        },
      } satisfies DevDeliverySeedReceipt;
    }).pipe(Effect.provide(runtime));
    return yield* seed.pipe(
      Effect.catch((cause) =>
        cause instanceof DevDeliverySeedServerOffError || !isDatabaseContention(cause)
          ? Effect.fail(cause)
          : Effect.fail(new DevDeliverySeedServerOffError(cause)),
      ),
    );
  });

/** Test-only proof that nested production writes roll back as one durable scenario. */
export const verifyDevDeliverySeedRollback = (requestedBaseDir: string) =>
  Effect.gen(function* () {
    const baseDir = validateIsolatedBaseDir(requestedBaseDir);
    const runId = `j5-a2a-rollback-${crypto.randomUUID()}`;
    const squadronId = SquadronId.make(`squadron:${runId}`);
    const senderId = ParticipantId.make(`agent:${runId}:sender`);
    const senderThreadId = ThreadId.make(`thread:${runId}:sender`);
    const createdAt = new Date().toISOString();
    const runtime = makeRuntimeLayer(baseDir);
    return yield* Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const failedScenario = yield* Effect.exit(
        atomicScenario(
          "controlled-mid-scenario-failure",
          Effect.gen(function* () {
            yield* ledger.createSquadron({
              squadron: { id: squadronId, name: `J5 rollback ${runId}`, createdAt },
            });
            yield* ledger.appendEvents({
              commandId: CommCommandId.make(seededId(runId, "membership")),
              squadronId,
              acceptedAt: createdAt,
              events: [
                {
                  kind: "participant.joined",
                  sender: null,
                  receiver: senderId,
                  exchangeId: null,
                  correlationId: null,
                  payload: {
                    participant: { kind: "agent", id: senderId, threadId: senderThreadId },
                  },
                  createdAt,
                },
              ],
            });
            return yield* Effect.fail(new Error("Controlled failure after durable ledger writes."));
          }),
        ),
      );
      if (failedScenario._tag !== "Failure") {
        return yield* Effect.die("Controlled rollback scenario unexpectedly committed.");
      }
      const squads = yield* ledger.listSquadrons();
      if (squads.some((squadron) => squadron.id === squadronId)) {
        return yield* Effect.die("Controlled rollback left durable A2A state behind.");
      }
    }).pipe(Effect.provide(runtime));
  });
