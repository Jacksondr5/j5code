import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  j5ClaimMissedClaudeSteer,
  j5ClaudeSteerFields,
  j5ForgetClaudeSteers,
  j5IsMissedClaudeSteerTurn,
  j5NoteMissedClaudeSteers,
  j5ObserveClaudeSteer,
  j5OfferClaudeSteer,
} from "./claudeAgentSteers.ts";

// Steer state is module-wide, so each test uses turns, native threads and messages of its own.
let nextTurn = 0;
const newTurn = () => `provider-turn-${++nextTurn}`;
let nextNativeThread = 0;
const newNativeThread = () => `native-thread-${++nextNativeThread}`;

const newQuery = () => ({}) as ClaudeAgentSdkQuerySession;

const lifecycle = (commandUuid: string, state: string) =>
  ({ type: "command_lifecycle", command_uuid: commandUuid, state }) as unknown as SDKMessage;

const result = (overrides: Partial<SDKResultMessage> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    ...overrides,
  }) as SDKResultMessage;

/** Ends the turn and returns the message of the missed steer Claude Code then runs, if any. */
const endTurn = (
  query: ClaudeAgentSdkQuerySession,
  providerTurnId: string,
  ended: SDKResultMessage = result(),
) => {
  const nativeThreadId = newNativeThread();
  j5NoteMissedClaudeSteers({ query, nativeThreadId, providerTurnId, result: ended });
  return j5ClaimMissedClaudeSteer(nativeThreadId, query);
};

const offerAgentSteer = Effect.fnUntraced(function* (
  query: ClaudeAgentSdkQuerySession,
  providerTurnId: string,
  messageId = `message-${providerTurnId}`,
) {
  const steer = yield* j5ClaudeSteerFields(
    { createdBy: "agent" },
    yield* SecureRandom.SecureRandom,
  );
  yield* j5OfferClaudeSteer({ query, providerTurnId, messageId, steer, offer: Effect.void });
  return steer.uuid ?? assert.fail("An agent's steer has a uuid.");
});

it.effect("keeps a person's steer on now and sends any other with next and a uuid", () =>
  Effect.gen(function* () {
    const crypto = yield* SecureRandom.SecureRandom;
    assert.deepEqual(yield* j5ClaudeSteerFields({ createdBy: "user" }, crypto), {
      priority: "now",
    });
    for (const createdBy of ["agent", "system"] as const) {
      const steer = yield* j5ClaudeSteerFields({ createdBy }, crypto);
      assert.equal(steer.priority, "next");
      assert.isString(steer.uuid);
    }
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("gives a steer still queued at a clean result its own turn, not one Claude took", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const missedTurn = newTurn();
    const uuid = yield* offerAgentSteer(query, missedTurn, "message-missed");
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.equal(endTurn(query, missedTurn), "message-missed");
    assert.isTrue(j5IsMissedClaudeSteerTurn("message-missed"));

    const takenTurn = newTurn();
    const taken = yield* offerAgentSteer(query, takenTurn, "message-taken");
    j5ObserveClaudeSteer(query, lifecycle(taken, "queued"));
    j5ObserveClaudeSteer(query, lifecycle(taken, "started"));
    assert.isUndefined(endTurn(query, takenTurn));
    assert.isFalse(j5IsMissedClaudeSteerTurn("message-taken"));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("counts an unacknowledged steer as missed only once the CLI has reported lifecycle", () =>
  Effect.gen(function* () {
    const silent = newQuery();
    const silentTurn = newTurn();
    yield* offerAgentSteer(silent, silentTurn);
    assert.isUndefined(endTurn(silent, silentTurn));

    const reporting = newQuery();
    const reportingTurn = newTurn();
    j5ObserveClaudeSteer(reporting, lifecycle("the-turn-prompt", "started"));
    yield* offerAgentSteer(reporting, reportingTurn, "message-reporting");
    assert.equal(endTurn(reporting, reportingTurn), "message-reporting");
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each([
  { failure: "an execution error", overrides: { subtype: "error_during_execution" } },
  { failure: "a success flagged as an error", overrides: { is_error: true } },
  { failure: "the turn limit", overrides: { terminal_reason: "max_turns" } },
] as const)("misses no steer at a result that ends on $failure", ({ overrides }) =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const uuid = yield* offerAgentSteer(query, turn);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isUndefined(endTurn(query, turn, result(overrides as never)));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("follows a steer's lifecycle only on its own query, and only for known states", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const uuid = yield* offerAgentSteer(query, turn, "message-own-query");
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    j5ObserveClaudeSteer(newQuery(), lifecycle(uuid, "started"));
    j5ObserveClaudeSteer(query, lifecycle(uuid, "paused"));
    assert.equal(endTurn(query, turn), "message-own-query");
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("leaves nothing behind when the offer fails", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    j5ObserveClaudeSteer(query, lifecycle("the-turn-prompt", "started"));
    const steer = yield* j5ClaudeSteerFields(
      { createdBy: "agent" },
      yield* SecureRandom.SecureRandom,
    );
    const offered = yield* j5OfferClaudeSteer({
      query,
      providerTurnId: turn,
      messageId: "message-failed-offer",
      steer,
      offer: Effect.fail("closed"),
    }).pipe(Effect.flip);
    assert.equal(offered, "closed");
    assert.isUndefined(endTurn(query, turn));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("claims nothing for a query that has closed", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const nativeThreadId = newNativeThread();
    const uuid = yield* offerAgentSteer(query, turn, "message-closed-query");
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    j5NoteMissedClaudeSteers({ query, nativeThreadId, providerTurnId: turn, result: result() });
    assert.isUndefined(j5ClaimMissedClaudeSteer(nativeThreadId, newQuery()));
    assert.isUndefined(j5ClaimMissedClaudeSteer(nativeThreadId, query));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("claims missed steers in order, dropping those Claude ran in the same turn", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const nativeThreadId = newNativeThread();
    const first = yield* offerAgentSteer(query, turn, "message-first");
    const folded = yield* offerAgentSteer(query, turn, "message-folded");
    const later = yield* offerAgentSteer(query, turn, "message-later");
    for (const uuid of [first, folded, later]) {
      j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    }
    j5NoteMissedClaudeSteers({ query, nativeThreadId, providerTurnId: turn, result: result() });
    j5ObserveClaudeSteer(query, lifecycle(first, "started"));
    j5ObserveClaudeSteer(query, lifecycle(folded, "started"));
    assert.equal(j5ClaimMissedClaudeSteer(nativeThreadId, query), "message-first");
    assert.equal(j5ClaimMissedClaudeSteer(nativeThreadId, query), "message-later");
    assert.isUndefined(j5ClaimMissedClaudeSteer(nativeThreadId, query));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("releases a terminated run's steers without clearing another's", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const turn = newTurn();
    const otherTurn = newTurn();
    const nativeThreadId = newNativeThread();
    const waiting = yield* offerAgentSteer(query, turn, "message-waiting");
    const other = yield* offerAgentSteer(query, otherTurn, "message-other-turn");
    j5ObserveClaudeSteer(query, lifecycle(waiting, "queued"));
    j5ObserveClaudeSteer(query, lifecycle(other, "queued"));
    j5ForgetClaudeSteers(["message-waiting"]);
    j5NoteMissedClaudeSteers({ query, nativeThreadId, providerTurnId: turn, result: result() });
    j5NoteMissedClaudeSteers({
      query,
      nativeThreadId,
      providerTurnId: otherTurn,
      result: result(),
    });
    assert.equal(j5ClaimMissedClaudeSteer(nativeThreadId, query), "message-other-turn");
    j5ForgetClaudeSteers(["message-other-turn"]);
    assert.isFalse(j5IsMissedClaudeSteerTurn("message-other-turn"));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
