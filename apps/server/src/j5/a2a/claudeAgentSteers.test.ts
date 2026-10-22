import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  j5ClaudeSteerFields,
  j5ClaudeSteerHoldsResult,
  j5ObserveClaudeSteer,
  j5OfferClaudeSteer,
} from "./claudeAgentSteers.ts";

const TURN = "provider-turn-1";

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

const offerAgentSteer = Effect.fnUntraced(function* (query: ClaudeAgentSdkQuerySession) {
  const steer = yield* j5ClaudeSteerFields({ createdBy: "agent" }, yield* Crypto.Crypto);
  yield* j5OfferClaudeSteer({ query, providerTurnId: TURN, steer, offer: Effect.void });
  return steer.uuid ?? assert.fail("An agent's steer has a uuid.");
});

it.effect("keeps a person's steer on now and sends any other with next and a uuid", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
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

it.effect("holds a clean result while a steer is queued, and not once Claude takes it", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const uuid = yield* offerAgentSteer(query);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isTrue(j5ClaudeSteerHoldsResult(query, TURN, result()));
    j5ObserveClaudeSteer(query, lifecycle(uuid, "started"));
    assert.isFalse(j5ClaudeSteerHoldsResult(query, TURN, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("holds for an unacknowledged steer only once the CLI has reported lifecycle", () =>
  Effect.gen(function* () {
    const silent = newQuery();
    yield* offerAgentSteer(silent);
    assert.isFalse(j5ClaudeSteerHoldsResult(silent, TURN, result()));

    const reporting = newQuery();
    j5ObserveClaudeSteer(reporting, lifecycle("the-turn-prompt", "started"));
    yield* offerAgentSteer(reporting);
    assert.isTrue(j5ClaudeSteerHoldsResult(reporting, TURN, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("never holds a failed result", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const uuid = yield* offerAgentSteer(query);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isFalse(
      j5ClaudeSteerHoldsResult(query, TURN, result({ subtype: "error_during_execution" } as never)),
    );
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("keeps following its steers across a person's aborting steer", () =>
  Effect.gen(function* () {
    const query = newQuery();
    const uuid = yield* offerAgentSteer(query);
    j5ObserveClaudeSteer(query, lifecycle(uuid, "queued"));
    assert.isFalse(
      j5ClaudeSteerHoldsResult(query, TURN, result({ terminal_reason: "aborted_tools" })),
    );
    assert.isTrue(j5ClaudeSteerHoldsResult(query, TURN, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("leaves nothing behind when the offer fails", () =>
  Effect.gen(function* () {
    const query = newQuery();
    j5ObserveClaudeSteer(query, lifecycle("the-turn-prompt", "started"));
    const steer = yield* j5ClaudeSteerFields({ createdBy: "agent" }, yield* Crypto.Crypto);
    const offered = yield* j5OfferClaudeSteer({
      query,
      providerTurnId: TURN,
      steer,
      offer: Effect.fail("closed"),
    }).pipe(Effect.flip);
    assert.equal(offered, "closed");
    assert.isFalse(j5ClaudeSteerHoldsResult(query, TURN, result()));
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
