import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/**
 * A steer from an agent or the server waits for a Claude turn's running tool calls instead of
 * cancelling them (FORK.md case 82, register D4). Upstream sends every steer with priority
 * "now", which cancels the turn's running tool calls and makes Claude report a refusal nobody
 * gave. Priority "next" is Claude Code's own mid-turn path: the CLI lets the running tool calls
 * finish and adds the message to the turn at the next tool result. A person's steer keeps
 * upstream's "now", so it still cuts in at once.
 *
 * A "next" steer offered after the turn's last tool call is still queued when the turn's result
 * arrives, and Claude runs it as another native turn. The adapter keeps the turn open for it by
 * following the steer's `command_lifecycle` frames. A CLI that sends none never holds a turn
 * open: the steer's native turn then reaches the thread through upstream's wake-turn path.
 *
 * Kept as a leaf module so the Claude adapter carries only its hook calls. State is keyed by the
 * live query, so it goes when the query does.
 */

type SteerState = "offered" | "queued" | "dequeued";

interface QuerySteers {
  reportsLifecycle: boolean;
  readonly byTurn: Map<string, Map<string, SteerState>>;
}

const steersByQuery = new WeakMap<ClaudeAgentSdkQuerySession, QuerySteers>();

const querySteers = (query: ClaudeAgentSdkQuerySession) => {
  const existing = steersByQuery.get(query);
  if (existing !== undefined) return existing;
  const created: QuerySteers = { reportsLifecycle: false, byTurn: new Map() };
  steersByQuery.set(query, created);
  return created;
};

export interface J5ClaudeSteerFields {
  readonly priority: "now" | "next";
  readonly uuid?: SteerUuid;
}

type SteerUuid = NonNullable<SDKUserMessage["uuid"]>;
const isSteerUuid = (value: string): value is SteerUuid =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Spread into the steer's user message in place of upstream's `priority: "now"`. */
export const j5ClaudeSteerFields = Effect.fnUntraced(function* (
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy">,
  crypto: Crypto.Crypto,
) {
  if (message.createdBy === "user") return { priority: "now" } satisfies J5ClaudeSteerFields;
  const uuid = yield* crypto.randomUUIDv4().pipe(Effect.filterOrFail(isSteerUuid));
  return { priority: "next", uuid } satisfies J5ClaudeSteerFields;
});

/**
 * Offers the steer, tracking a "next" one from before the offer so a lifecycle frame can't
 * arrive untracked. A failed offer leaves nothing behind that would hold the turn.
 */
export const j5OfferClaudeSteer = <E>(input: {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly providerTurnId: string;
  readonly steer: J5ClaudeSteerFields;
  readonly offer: Effect.Effect<void, E>;
}): Effect.Effect<void, E> => {
  const uuid = input.steer.uuid;
  if (uuid === undefined) return input.offer;
  const withdraw = Effect.sync(() => {
    querySteers(input.query).byTurn.get(input.providerTurnId)?.delete(uuid);
  });
  return Effect.sync(() => {
    const { byTurn } = querySteers(input.query);
    const steers = byTurn.get(input.providerTurnId) ?? new Map<string, SteerState>();
    steers.set(uuid, "offered");
    byTurn.set(input.providerTurnId, steers);
  }).pipe(
    Effect.andThen(input.offer),
    Effect.onError(() => withdraw),
  );
};

/** Called for every SDK frame on the query. */
export const j5ObserveClaudeSteer = (query: ClaudeAgentSdkQuerySession, message: SDKMessage) => {
  // The SDK doesn't type command_lifecycle frames; upstream reads them the same way.
  const type: unknown = Reflect.get(message, "type");
  if (type !== "command_lifecycle") return;
  const uuid: unknown = Reflect.get(message, "command_uuid");
  const state: unknown = Reflect.get(message, "state");
  if (typeof uuid !== "string" || typeof state !== "string") return;
  const steers = querySteers(query);
  steers.reportsLifecycle = true;
  for (const turn of steers.byTurn.values()) {
    if (turn.has(uuid)) turn.set(uuid, state === "queued" ? "queued" : "dequeued");
  }
};

const isAbortResult = (result: SDKResultMessage) =>
  result.terminal_reason === "aborted_tools" || result.terminal_reason === "aborted_streaming";

/**
 * Whether the turn's result is one segment of the turn rather than its end: a steer of the turn
 * is still to run. Only a clean completion is held, so a failure ends the turn and shows.
 */
export const j5ClaudeSteerHoldsResult = (
  query: ClaudeAgentSdkQuerySession,
  providerTurnId: string,
  result: SDKResultMessage,
): boolean => {
  const steers = steersByQuery.get(query);
  const turn = steers?.byTurn.get(providerTurnId);
  if (steers === undefined || turn === undefined) return false;
  // A person's "now" steer aborts the segment and the turn carries on, still owning its steers.
  if (isAbortResult(result)) return false;
  const waiting = [...turn.values()].some(
    (state) => state === "queued" || (state === "offered" && steers.reportsLifecycle),
  );
  const completed =
    result.subtype === "success" &&
    !result.is_error &&
    (result.terminal_reason === undefined || result.terminal_reason === "completed");
  if (waiting && completed) return true;
  steers.byTurn.delete(providerTurnId);
  return false;
};
