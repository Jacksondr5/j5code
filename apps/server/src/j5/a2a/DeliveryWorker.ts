import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as Scope from "effect/Scope";

import config from "./delivery-config.v1.json" with { type: "json" };
import { A2ADeliveryTransport, type A2ADeliveryTransportError } from "./DeliveryTransport.ts";
import {
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
  type DeliveryAlarm,
  type DeliveryMilestone,
} from "./contracts.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export const A2A_DELIVERY_CONFIG_VERSION = config.version;

interface DeliveryRow {
  readonly squadron_id: string;
  readonly message_id: string;
  readonly sent_seq: number;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly receiver_squadron_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply";
  readonly envelope_channel: "peer" | "silence_notice";
  readonly correlation_id: string;
  readonly message_text: string;
  readonly status: "pending" | "retry_scheduled" | "delivered" | "alarmed";
  readonly attempts: number;
  readonly created_at: string;
}

interface OpenExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

export interface DeliveryAttempt {
  readonly squadronId: SquadronId;
  readonly messageId: LedgerMessageId;
  readonly attempt: number;
}

export interface A2ADeliveryHooksShape {
  readonly afterTransportSuccess: (
    attempt: DeliveryAttempt,
  ) => Effect.Effect<void, A2ADeliveryHookError>;
}

export class A2ADeliveryHookError extends Schema.TaggedErrorClass<A2ADeliveryHookError>()(
  "A2ADeliveryHookError",
  { cause: Schema.Defect() },
) {}

export class A2ADeliveryWorkerError extends Schema.TaggedErrorClass<A2ADeliveryWorkerError>()(
  "A2ADeliveryWorkerError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class A2ADeliveryHooks extends Context.Service<A2ADeliveryHooks, A2ADeliveryHooksShape>()(
  "t3/j5/a2a/DeliveryWorker/A2ADeliveryHooks",
) {}

export const noopHooks = Layer.succeed(
  A2ADeliveryHooks,
  A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
);

export interface A2ADeliveryWorkerShape {
  readonly notify: Effect.Effect<void>;
  readonly runOnce: Effect.Effect<DeliveryMilestone | null, A2ADeliveryWorkerError>;
  readonly drain: Effect.Effect<ReadonlyArray<DeliveryMilestone>, A2ADeliveryWorkerError>;
  readonly listAlarms: Effect.Effect<ReadonlyArray<DeliveryAlarm>, A2ADeliveryWorkerError>;
  readonly subscribeMilestones: Effect.Effect<Stream.Stream<DeliveryMilestone>, never, Scope.Scope>;
}

export class A2ADeliveryWorker extends Context.Service<A2ADeliveryWorker, A2ADeliveryWorkerShape>()(
  "t3/j5/a2a/DeliveryWorker/A2ADeliveryWorker",
) {}

type A2ADeliveryAttemptError =
  | A2ALedgerError
  | A2ADeliveryTransportError
  | A2ADeliveryHookError
  | SqlError;

const errorText = (cause: Cause.Cause<A2ADeliveryAttemptError>) =>
  Cause.pretty(cause).slice(0, 4_000);

const workerError = (operation: string) => (cause: unknown) =>
  new A2ADeliveryWorkerError({ operation, cause });

const backoffMs = (attempt: number) =>
  Math.min(config.initialBackoffMs * 2 ** Math.max(0, attempt - 1), config.maximumBackoffMs);

const commandId = (operation: string, messageId: LedgerMessageId, attempt?: number) =>
  CommCommandId.make(
    ["command", "j5", "a2a", operation, encodeURIComponent(messageId), attempt]
      .filter((part) => part !== undefined)
      .join(":"),
  );

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    A2ADeliveryWorker,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const transport = yield* A2ADeliveryTransport;
      const hooks = yield* A2ADeliveryHooks;
      const sql = yield* SqlClient.SqlClient;
      const wakeups = yield* Queue.unbounded<void>();
      const milestones = yield* PubSub.unbounded<DeliveryMilestone>();
      const drainPermit = yield* Semaphore.make(1);

      const appendReceiverEntry = Effect.fn("j5.a2a.delivery.appendReceiverEntry")(function* (
        row: DeliveryRow,
      ) {
        if (row.squadron_id === row.receiver_squadron_id) return;
        const originSquadronId = SquadronId.make(row.squadron_id);
        const receiverSquadronId = SquadronId.make(row.receiver_squadron_id);
        const exchangeId = row.exchange_id === null ? null : ExchangeId.make(row.exchange_id);
        const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const events: Array<CommEvent> = [
          {
            kind: "message.received",
            sender: ParticipantId.make(row.sender_id),
            receiver: ParticipantId.make(row.receiver_id),
            exchangeId,
            correlationId: CorrelationId.make(row.correlation_id),
            payload: {
              originSquadronId,
              message: {
                messageId: row.message_id,
                text: row.message_text,
                originSquadronId,
                receiverSquadronId,
                exchangeRole: row.exchange_role,
                envelopeChannel: row.envelope_channel,
              },
            },
            createdAt: receivedAt,
          },
        ];
        if (exchangeId !== null) {
          const exchanges = yield* sql<OpenExchangeRow>`
            SELECT squadron_id, exchange_id, sender_id, receiver_id
            FROM j5_a2a_exchange
            WHERE squadron_id = ${receiverSquadronId}
              AND exchange_id = ${exchangeId}
              AND status = 'open'
              AND sender_id = ${row.receiver_id}
              AND receiver_id = ${row.sender_id}
            LIMIT 1
          `;
          if (exchanges[0] !== undefined) {
            events.push({
              kind: "exchange.closed",
              sender: ParticipantId.make(row.sender_id),
              receiver: ParticipantId.make(row.receiver_id),
              exchangeId,
              correlationId: CorrelationId.make(row.correlation_id),
              payload: { replyMessageId: LedgerMessageId.make(row.message_id) },
              createdAt: receivedAt,
            });
          }
        }
        yield* ledger.appendEvents({
          commandId: commandId("receive", LedgerMessageId.make(row.message_id)),
          squadronId: receiverSquadronId,
          acceptedAt: receivedAt,
          events,
        });
      });

      const attemptDelivery = Effect.fn("j5.a2a.delivery.attempt")(function* (
        row: DeliveryRow,
        attempt: number,
      ) {
        const originSquadronId = SquadronId.make(row.squadron_id);
        const receiverSquadronId = SquadronId.make(row.receiver_squadron_id);
        const messageId = LedgerMessageId.make(row.message_id);
        const senderId = ParticipantId.make(row.sender_id);
        const receiverId = ParticipantId.make(row.receiver_id);
        const exchangeId = row.exchange_id === null ? null : ExchangeId.make(row.exchange_id);
        yield* appendReceiverEntry(row);
        if (receiverId === GLOBAL_HUMAN_PARTICIPANT_ID) {
          yield* transport.deliverHuman({
            originSquadronId,
            receiverSquadronId,
            messageId,
            senderId,
            receiverId,
            exchangeId,
            message: row.message_text,
            envelopeChannel: row.envelope_channel,
            createdAt: row.created_at,
          });
        } else {
          yield* transport.deliverAgent({
            originSquadronId,
            receiverSquadronId,
            messageId,
            senderId,
            receiverId,
            exchangeId,
            message: row.message_text,
            envelopeChannel: row.envelope_channel,
          });
        }
        yield* hooks.afterTransportSuccess({ squadronId: originSquadronId, messageId, attempt });
        const deliveredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* ledger.appendEvents({
          commandId: commandId("delivered", messageId),
          squadronId: originSquadronId,
          acceptedAt: deliveredAt,
          events: [
            {
              kind: "message.delivered",
              sender: senderId,
              receiver: receiverId,
              exchangeId,
              correlationId: CorrelationId.make(row.correlation_id),
              payload: {
                messageId,
                attempt,
                channel: receiverId === GLOBAL_HUMAN_PARTICIPANT_ID ? "human" : "agent",
              },
              createdAt: deliveredAt,
            },
          ],
        });
      });

      const recordFailure = Effect.fn("j5.a2a.delivery.recordFailure")(function* (
        row: DeliveryRow,
        attempt: number,
        cause: Cause.Cause<A2ADeliveryAttemptError>,
      ) {
        const failedAtDate = yield* DateTime.now;
        const failedAt = DateTime.formatIso(failedAtDate);
        const alarmed = attempt >= config.alarmAfterAttempts;
        const nextAttemptAt = alarmed
          ? null
          : DateTime.formatIso(DateTime.add(failedAtDate, { milliseconds: backoffMs(attempt) }));
        const messageId = LedgerMessageId.make(row.message_id);
        yield* ledger.appendEvents({
          commandId: commandId("failed", messageId, attempt),
          squadronId: SquadronId.make(row.squadron_id),
          acceptedAt: failedAt,
          events: [
            {
              kind: "message.delivery_failed",
              sender: ParticipantId.make(row.sender_id),
              receiver: ParticipantId.make(row.receiver_id),
              exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
              correlationId: CorrelationId.make(row.correlation_id),
              payload: {
                messageId,
                attempt,
                error: errorText(cause),
                nextAttemptAt,
                alarmed,
              },
              createdAt: failedAt,
            },
          ],
        });
        return {
          squadronId: SquadronId.make(row.squadron_id),
          messageId,
          state: alarmed ? ("alarmed" as const) : ("retry_scheduled" as const),
          attempt,
        } satisfies DeliveryMilestone;
      });

      const runOnceRaw = Effect.gen(function* () {
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const rows = yield* sql<DeliveryRow>`
          SELECT
            squadron_id,
            message_id,
            sent_seq,
            sender_id,
            receiver_id,
            receiver_squadron_id,
            exchange_id,
            exchange_role,
            envelope_channel,
            correlation_id,
            message_text,
            status,
            attempts,
            created_at
          FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY sent_seq, squadron_id, message_id
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;
        const attempt = row.attempts + 1;
        const exit = yield* Effect.exit(attemptDelivery(row, attempt));
        const milestone =
          exit._tag === "Success"
            ? ({
                squadronId: SquadronId.make(row.squadron_id),
                messageId: LedgerMessageId.make(row.message_id),
                state: "delivered",
                attempt,
              } satisfies DeliveryMilestone)
            : yield* recordFailure(row, attempt, exit.cause);
        yield* PubSub.publish(milestones, milestone);
        return milestone;
      });
      const runOnceEffect = runOnceRaw.pipe(Effect.mapError(workerError("run one delivery")));
      const runOnce: A2ADeliveryWorkerShape["runOnce"] = drainPermit.withPermit(runOnceEffect);

      const drainEffect = Effect.fn("j5.a2a.delivery.drain")(function* () {
        const completed: Array<DeliveryMilestone> = [];
        while (true) {
          const milestone = yield* runOnceEffect;
          if (milestone === null) return completed;
          completed.push(milestone);
        }
      });
      const drain: A2ADeliveryWorkerShape["drain"] = drainPermit.withPermit(drainEffect());

      const nextDelay = Effect.fn("j5.a2a.delivery.nextDelay")(function* () {
        const rows = yield* sql<{ readonly next_attempt_at: string | null }>`
          SELECT next_attempt_at
          FROM j5_a2a_delivery
          WHERE status IN ('pending', 'retry_scheduled')
          ORDER BY next_attempt_at IS NOT NULL, next_attempt_at, sent_seq
          LIMIT 1
        `;
        const value = rows[0]?.next_attempt_at;
        if (value === undefined) return null;
        if (value === null) return 0;
        const now = yield* DateTime.now;
        return Math.max(0, Date.parse(value) - DateTime.toEpochMillis(now));
      });

      const runDaemon = Effect.forever(
        Effect.gen(function* () {
          yield* drain;
          const delay = yield* nextDelay();
          if (delay === null) {
            yield* Queue.take(wakeups);
          } else if (delay === 0) {
            yield* Effect.yieldNow;
          } else {
            yield* Effect.raceFirst(Queue.take(wakeups), Effect.sleep(Duration.millis(delay)));
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 A2A delivery drain failed", { cause }).pipe(
              Effect.andThen(
                Effect.raceFirst(
                  Queue.take(wakeups),
                  Effect.sleep(Duration.millis(config.initialBackoffMs)),
                ),
              ),
            ),
          ),
        ),
      );
      if (daemon) {
        yield* Effect.forkScoped(runDaemon);
      }
      yield* Queue.offer(wakeups, undefined);

      return A2ADeliveryWorker.of({
        notify: Queue.offer(wakeups, undefined).pipe(Effect.asVoid),
        runOnce,
        drain,
        listAlarms: sql<{
          readonly squadron_id: string;
          readonly message_id: string;
          readonly attempts: number;
          readonly last_error: string;
        }>`
          SELECT squadron_id, message_id, attempts, last_error
          FROM j5_a2a_delivery
          WHERE status = 'alarmed'
          ORDER BY updated_at, squadron_id, message_id
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              squadronId: SquadronId.make(row.squadron_id),
              messageId: LedgerMessageId.make(row.message_id),
              attempts: row.attempts,
              lastError: row.last_error,
            })),
          ),
          Effect.mapError(workerError("list delivery alarms")),
        ),
        subscribeMilestones: PubSub.subscribe(milestones).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      });
    }),
  );

export const manualLayer = makeLayer(false).pipe(Layer.provide(noopHooks));
export const layer = makeLayer(true).pipe(Layer.provide(noopHooks));
export const layerWithHooks = (daemon: boolean) => makeLayer(daemon);
