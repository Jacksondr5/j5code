import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  CommCommandId,
  EpicId,
  ExchangeId,
  type JoinEpicInput,
  type JoinEpicResult,
  type Membership,
  ParticipantId,
} from "./contracts.ts";
import { formatEpicSwitchWarning } from "./EnvelopeFormatter.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export class A2AEpicSelectionRequiredError extends Schema.TaggedErrorClass<A2AEpicSelectionRequiredError>()(
  "A2AEpicSelectionRequiredError",
  { epicIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This thread belongs to multiple epics (${this.epicIds.join(", ")}). Retry join_epic with one explicit epic_id to select it.`;
  }
}

export type A2AEpicBootstrapError = A2ALedgerError | A2AEpicSelectionRequiredError | SqlError;

export interface A2AEpicBootstrapShape {
  readonly joinEpic: (input: JoinEpicInput) => Effect.Effect<JoinEpicResult, A2AEpicBootstrapError>;
}

export class A2AEpicBootstrap extends Context.Service<A2AEpicBootstrap, A2AEpicBootstrapShape>()(
  "t3/j5/a2a/EpicBootstrapService/A2AEpicBootstrap",
) {}

const stablePart = (value: string) => encodeURIComponent(value);

const defaultEpicId = (threadId: ThreadId) => EpicId.make(`epic:j5:a2a:${stablePart(threadId)}`);

const defaultParticipantId = (threadId: ThreadId) =>
  ParticipantId.make(`agent:j5:a2a:${stablePart(threadId)}`);

const membershipCommandId = (
  operation: "join" | "leave",
  threadId: ThreadId,
  epicId: EpicId,
  incarnation: string,
) =>
  CommCommandId.make(
    `command:j5:a2a:bootstrap:${operation}:${stablePart(threadId)}:${stablePart(epicId)}:${stablePart(incarnation)}`,
  );

interface OpenExchangeRow {
  readonly epic_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

type A2AEpicBootstrapLayer = Layer.Layer<A2AEpicBootstrap, never, A2ALedger | SqlClient.SqlClient>;

export const layer: A2AEpicBootstrapLayer = Layer.effect(
  A2AEpicBootstrap,
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;

    const membershipsForThread = Effect.fn("j5.a2a.bootstrap.membershipsForThread")(function* (
      threadId: ThreadId,
    ) {
      const epics = yield* ledger.listEpics();
      const memberships = yield* Effect.forEach(epics, (epic) => ledger.listMembership(epic.id), {
        concurrency: 1,
      });
      return memberships
        .flat()
        .filter(
          (membership): membership is Membership & { participant: { kind: "agent" } } =>
            membership.participant.kind === "agent" && membership.participant.threadId === threadId,
        );
    });

    const joinEpic: A2AEpicBootstrapShape["joinEpic"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* membershipsForThread(input.senderThreadId);
        if (input.epicId === undefined && existing.length > 1) {
          return yield* new A2AEpicSelectionRequiredError({
            epicIds: existing.map((membership) => membership.epicId),
          });
        }
        if (input.epicId === undefined && existing[0] !== undefined) {
          return {
            epicId: existing[0].epicId,
            participantId: existing[0].participant.id,
            state: "selected",
            previousEpicIds: [],
            openExchangeWarnings: [],
          };
        }

        const targetEpicId = input.epicId ?? defaultEpicId(input.senderThreadId);
        const targetMembership = existing.find((membership) => membership.epicId === targetEpicId);
        const participantId =
          targetMembership?.participant.id ??
          existing[0]?.participant.id ??
          defaultParticipantId(input.senderThreadId);
        const currentEpics = yield* ledger.listEpics();
        const targetEpic = currentEpics.find((epic) => epic.id === targetEpicId);
        const created = targetEpic === undefined;
        if (created) {
          yield* ledger.createEpic({
            epic: {
              id: targetEpicId,
              name: `J5 epic ${targetEpicId}`,
              createdAt: input.acceptedAt,
            },
          });
        }

        const previous = existing.filter((membership) => membership.epicId !== targetEpicId);
        const previousParticipantByEpic = new Map(
          previous.map((membership) => [membership.epicId, membership.participant.id] as const),
        );
        const openExchangeWarnings =
          previous.length === 0
            ? []
            : (yield* sql<OpenExchangeRow>`
                  SELECT epic_id, exchange_id, sender_id, receiver_id
                  FROM j5_a2a_exchange
                  WHERE status = 'open'
                  ORDER BY epic_id, exchange_id
                `).flatMap((row) => {
                const leavingParticipantId = previousParticipantByEpic.get(row.epic_id as EpicId);
                if (
                  leavingParticipantId === undefined ||
                  (row.sender_id !== leavingParticipantId &&
                    row.receiver_id !== leavingParticipantId)
                ) {
                  return [];
                }
                const warning = {
                  epicId: EpicId.make(row.epic_id),
                  exchangeId: ExchangeId.make(row.exchange_id),
                  peerId: ParticipantId.make(
                    row.sender_id === leavingParticipantId ? row.receiver_id : row.sender_id,
                  ),
                };
                return [{ ...warning, message: formatEpicSwitchWarning(warning) }];
              });
        for (const membership of previous) {
          yield* ledger.appendEvents({
            commandId: membershipCommandId(
              "leave",
              input.senderThreadId,
              membership.epicId,
              String(membership.joinedSeq),
            ),
            epicId: membership.epicId,
            acceptedAt: input.acceptedAt,
            events: [
              {
                kind: "participant.left",
                sender: null,
                receiver: membership.participant.id,
                exchangeId: null,
                correlationId: null,
                payload: { participant: membership.participant },
                createdAt: input.acceptedAt,
              },
            ],
          });
        }

        if (targetMembership === undefined) {
          const sourceIncarnation =
            existing
              .map((membership) => `${membership.epicId}:${membership.joinedSeq}`)
              .sort()
              .join(",") || "initial";
          const participant = {
            kind: "agent" as const,
            id: participantId,
            threadId: input.senderThreadId,
          };
          yield* ledger.appendEvents({
            commandId: membershipCommandId(
              "join",
              input.senderThreadId,
              targetEpicId,
              sourceIncarnation,
            ),
            epicId: targetEpicId,
            acceptedAt: input.acceptedAt,
            events: [
              {
                kind: "participant.joined",
                sender: null,
                receiver: participantId,
                exchangeId: null,
                correlationId: null,
                payload: { participant },
                createdAt: input.acceptedAt,
              },
            ],
          });
        }

        return {
          epicId: targetEpicId,
          participantId,
          state: created ? "created" : targetMembership === undefined ? "joined" : "selected",
          previousEpicIds: previous.map((membership) => membership.epicId),
          openExchangeWarnings,
        };
      });

    return A2AEpicBootstrap.of({ joinEpic });
  }),
);
