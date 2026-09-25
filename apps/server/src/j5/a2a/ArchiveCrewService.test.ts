import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import {
  ArchiveAgentOperationError,
  ArchiveAgentService,
  type ArchiveAgentInput,
  type ArchiveAgentTargetFacts,
} from "./ArchiveAgentService.ts";
import {
  ArchiveCrewConfirmationRequiredError,
  ArchiveCrewConfirmationStaleError,
  ArchiveCrewNotCaptainError,
  ArchiveCrewPartialFailureError,
  ArchiveCrewService,
  layer as archiveCrewLayer,
  type ArchiveCrewInput,
} from "./ArchiveCrewService.ts";
import { ExchangeId, ParticipantId, SquadronId } from "./contracts.ts";

const squadronId = SquadronId.make("squadron:j5:archive-crew");
const captain = ParticipantId.make("agent:j5:a2a:captain");
const builder = ParticipantId.make("agent:j5:a2a:thread:builder");
const critic = ParticipantId.make("agent:j5:a2a:thread:critic");
const instance: AgentCrewInstance = {
  id: "crew:j5:test",
  squadronId,
  captainParticipantId: captain,
  captainThreadId: ThreadId.make("t:captain"),
  brief: "Implement and review the login fix.",
  version: 1,
  displayName: "Review Pair",
  createdAt: "2026-09-09T16:00:00.000Z",
  archivedAt: null,
  members: [
    {
      seatName: "builder",
      agentId: "builder",
      participantId: builder,
      threadId: ThreadId.make("t:b"),
      addedVersion: 1,
      reason: null,
    },
    {
      seatName: "critic",
      agentId: "critic",
      participantId: critic,
      threadId: ThreadId.make("t:c"),
      addedVersion: 1,
      reason: null,
    },
  ],
};
const openExchange = {
  exchangeId: ExchangeId.make("exchange:j5:archive-crew"),
  direction: "inbound" as const,
  replyObligation: "participant-owes-reply" as const,
  counterpartyId: captain,
  intent: "Review the fix",
  urgency: null,
  openedAt: "2026-09-09T16:05:00.000Z",
};

const fixture = Effect.gen(function* () {
  const facts = yield* Ref.make<Record<string, ArchiveAgentTargetFacts>>({
    [builder]: {
      facts: { openExchanges: [openExchange], runningTurn: null },
      threadArchived: false,
      retired: false,
    },
    [critic]: {
      facts: { openExchanges: [], runningTurn: { runId: RunId.make("run:c"), status: "running" } },
      threadArchived: false,
      retired: false,
    },
  });
  const archived = yield* Ref.make<ReadonlyArray<ArchiveAgentInput>>([]);
  const failSeat = yield* Ref.make<ParticipantId | null>(null);
  const marked = yield* Ref.make<ReadonlyArray<string>>([]);
  const crewArchivedAt = yield* Ref.make<string | null>(null);
  const layer = archiveCrewLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ArchiveAgentService)({
          readFacts: (target) =>
            Ref.get(facts).pipe(Effect.map((current) => current[target.participantId]!)),
          archive: (input) =>
            Effect.gen(function* () {
              // Mirrors the real service: a retired member replays as already archived.
              if ((yield* Ref.get(facts))[input.target.participantId]?.retired)
                return "already_archived" as const;
              if ((yield* Ref.get(failSeat)) === input.target.participantId)
                return yield* new ArchiveAgentOperationError({
                  phase: "committing the target thread archive",
                  cause: new Error("injected"),
                });
              yield* Ref.update(archived, (items) => [...items, input]);
              yield* Ref.update(facts, (current) => ({
                ...current,
                [input.target.participantId]: {
                  facts: { openExchanges: [], runningTurn: null },
                  threadArchived: true,
                  retired: true,
                },
              }));
              return "archived" as const;
            }),
        }),
        Layer.mock(AgentCrewInstanceService)({
          serialize: (_id, effect) => effect,
          read: (id) =>
            Ref.get(crewArchivedAt).pipe(
              Effect.map((archivedAt) => (id === instance.id ? { ...instance, archivedAt } : null)),
            ),
          markArchived: (id, archivedAt) =>
            Effect.all(
              [Ref.update(marked, (items) => [...items, id]), Ref.set(crewArchivedAt, archivedAt)],
              { discard: true },
            ),
          listForCaptain: (query) =>
            Ref.get(crewArchivedAt).pipe(
              Effect.map((archivedAt) =>
                query.captainParticipantId === captain ? [{ ...instance, archivedAt }] : [],
              ),
            ),
        }),
        Layer.mock(ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        }),
      ),
    ),
  );
  const input = (overrides: Partial<ArchiveCrewInput> = {}): ArchiveCrewInput => ({
    providerSessionId: "session",
    callerParticipantId: captain,
    squadronId,
    crewInstanceId: instance.id,
    clientRequestKey: "archive-1",
    archivedAt: "2026-09-09T17:00:00.000Z",
    commandIds: (seat) => ({
      interruptCommandId: CommandId.make(`interrupt:${seat}`),
      archiveCommandId: CommandId.make(`archive:${seat}`),
    }),
    ...overrides,
  });
  return { layer, input, archived, failSeat, marked, facts };
});

it.effect("refuses until the captain confirms every member's facts, then retires the unit", () =>
  Effect.gen(function* () {
    const { layer, input, archived, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      assert.instanceOf(refusal, ArchiveCrewConfirmationRequiredError);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return;
      assert.deepStrictEqual(
        refusal.facts.members.map((member) => [
          member.seatName,
          member.facts.openExchanges.length,
          member.facts.runningTurn?.runId ?? null,
        ]),
        [
          ["builder", 1, null],
          ["critic", 0, "run:c"],
        ],
      );
      assert.include(refusal.message, "1 open exchange(s) and 1 running turn(s)");
      assert.include(refusal.message, "check with the user");
      assert.lengthOf(yield* Ref.get(archived), 0);

      const notCaptain = yield* service
        .archive(input({ callerParticipantId: builder }))
        .pipe(Effect.flip);
      assert.instanceOf(notCaptain, ArchiveCrewNotCaptainError);

      const garbage = yield* service
        .archive(input({ confirmationToken: "nope" }))
        .pipe(Effect.flip);
      assert.equal(garbage._tag, "ArchiveCrewConfirmationTokenError");

      const outcome = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.deepStrictEqual(outcome, {
        status: "archived",
        members: [
          { seatName: "builder", participantId: builder, result: "archived" },
          { seatName: "critic", participantId: critic, result: "archived" },
        ],
      });
      const calls = yield* Ref.get(archived);
      assert.deepStrictEqual(
        calls.map((call) => [
          call.target.participantId,
          call.confirmationSatisfied,
          call.archiveCommandId,
        ]),
        [
          [builder, true, CommandId.make("archive:builder")],
          [critic, true, CommandId.make("archive:critic")],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);

      const replay = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.equal(replay.status, "already_archived");
      assert.lengthOf(yield* Ref.get(archived), 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports a partial failure by seat and finishes on retry with the same token", () =>
  Effect.gen(function* () {
    const { layer, input, archived, failSeat, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return assert.fail();
      yield* Ref.set(failSeat, critic);
      const partial = yield* service
        .archive(input({ confirmationToken: refusal.confirmationToken }))
        .pipe(Effect.flip);
      assert.instanceOf(partial, ArchiveCrewPartialFailureError);
      if (partial instanceof ArchiveCrewPartialFailureError) {
        assert.deepStrictEqual(partial.archivedSeats, ["builder"]);
        assert.equal(partial.failedSeat, "critic");
        assert.include(partial.message, "same client_request_id and confirmation_token");
      }
      assert.deepStrictEqual(yield* Ref.get(marked), []);

      // Builder is retired now, so the current facts are a strict subset of the confirmed ones.
      yield* Ref.set(failSeat, null);
      const finished = yield* service.archive(
        input({ confirmationToken: refusal.confirmationToken }),
      );
      assert.equal(finished.status, "archived");
      assert.deepStrictEqual(
        (yield* Ref.get(archived)).map((call) => call.target.participantId),
        [builder, critic],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("treats a token as stale when a member gains new work after confirmation", () =>
  Effect.gen(function* () {
    const { layer, input, facts, archived } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      const refusal = yield* service.archive(input()).pipe(Effect.flip);
      if (!(refusal instanceof ArchiveCrewConfirmationRequiredError)) return assert.fail();
      yield* Ref.update(facts, (current) => ({
        ...current,
        [critic]: {
          ...current[critic]!,
          facts: {
            openExchanges: [{ ...openExchange, exchangeId: ExchangeId.make("exchange:new") }],
            runningTurn: null,
          },
        },
      }));
      const stale = yield* service
        .archive(input({ confirmationToken: refusal.confirmationToken }))
        .pipe(Effect.flip);
      assert.instanceOf(stale, ArchiveCrewConfirmationStaleError);
      if (stale instanceof ArchiveCrewConfirmationStaleError) {
        assert.isNotNull(stale.confirmationToken);
        assert.notEqual(stale.confirmationToken, refusal.confirmationToken);
      }
      assert.lengthOf(yield* Ref.get(archived), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retires the unit for a person whose dialog already listed every seat's facts", () =>
  Effect.gen(function* () {
    const { layer, input, archived, marked } = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* ArchiveCrewService;
      // The person's archive dialog reads the same seat facts the Captain's refusal would carry.
      const before = yield* service.readCaptainFacts({ squadronId, captainParticipantId: captain });
      assert.deepStrictEqual(
        before.map((entry) => [
          entry.instance.id,
          entry.facts.members.map((member) => [
            member.seatName,
            member.facts.openExchanges.length,
            member.facts.runningTurn !== null,
          ]),
        ]),
        [
          [
            instance.id,
            [
              ["builder", 1, false],
              ["critic", 0, true],
            ],
          ],
        ],
      );
      assert.deepStrictEqual(
        yield* service.readCaptainFacts({ squadronId, captainParticipantId: builder }),
        [],
      );

      // No token is minted or checked: the person is not a participant and confirmed already.
      const outcome = yield* service.archive(
        input({ callerParticipantId: null, squadronId: null, confirmationSatisfied: true }),
      );
      assert.equal(outcome.status, "archived");
      assert.deepStrictEqual(
        (yield* Ref.get(archived)).map((call) => [
          call.target.participantId,
          call.callerParticipantId,
          call.confirmationSatisfied,
        ]),
        [
          [builder, captain, true],
          [critic, captain, true],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(marked), [instance.id]);
      // Once retired, the Captain commands no live Crew and may be archived on its own.
      assert.deepStrictEqual(
        yield* service.readCaptainFacts({ squadronId, captainParticipantId: captain }),
        [],
      );
    }).pipe(Effect.provide(layer));
  }),
);
