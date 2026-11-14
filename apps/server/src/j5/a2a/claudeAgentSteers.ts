import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CommandId, type MessageId, type ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import type { ClaudeAgentSdkQuerySession } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * FORK.md case 89: a steer that isn't a person's goes to Claude with priority "next", which waits
 * for running tools. One still queued when the turn ends runs as Claude Code's next turn, and that
 * turn gets a run of its own carrying the steer's message.
 */

type SteerState = "offered" | "queued" | "taken" | "cancelled";

interface TrackedSteer {
  state: SteerState;
  readonly uuid: string;
  /** The thread message the steer carries. */
  readonly messageId: string;
  readonly query: ClaudeAgentSdkQuerySession;
}

/** Steers by provider turn, then uuid. A turn's entry goes at its result. */
const steersByTurn = new Map<string, Map<string, TrackedSteer>>();
/** Steers that missed their turn, by native thread, in the order they were offered. */
const missedByNativeThread = new Map<string, Array<TrackedSteer>>();
/** Messages whose run drains the Claude Code turn already running them instead of prompting. */
const missedSteerTurns = new Set<string>();
/** Queries whose CLI has sent a command_lifecycle frame. */
const reportsLifecycle = new WeakSet<ClaudeAgentSdkQuerySession>();

const stillToRun = (steer: TrackedSteer) =>
  steer.state === "queued" || (steer.state === "offered" && reportsLifecycle.has(steer.query));

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
  random: SecureRandom.SecureRandom["Service"],
) {
  if (message.createdBy === "user") return { priority: "now" } satisfies J5ClaudeSteerFields;
  const uuid = yield* random.uuidV4().pipe(Effect.filterOrFail(isSteerUuid));
  return { priority: "next", uuid } satisfies J5ClaudeSteerFields;
});

/**
 * Offers the steer, tracking a "next" one from before the offer so a lifecycle frame can't
 * arrive untracked. A failed offer leaves nothing behind.
 */
export const j5OfferClaudeSteer = <E>(input: {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly providerTurnId: string;
  readonly messageId: string;
  readonly steer: J5ClaudeSteerFields;
  readonly offer: Effect.Effect<void, E>;
}): Effect.Effect<void, E> => {
  const uuid = input.steer.uuid;
  if (uuid === undefined) return input.offer;
  const withdraw = Effect.sync(() => {
    steersByTurn.get(input.providerTurnId)?.delete(uuid);
  });
  return Effect.sync(() => {
    const steers = steersByTurn.get(input.providerTurnId) ?? new Map<string, TrackedSteer>();
    steers.set(uuid, { state: "offered", uuid, messageId: input.messageId, query: input.query });
    steersByTurn.set(input.providerTurnId, steers);
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
  reportsLifecycle.add(query);
  const next = lifecycleStates.get(state);
  if (next === undefined) return;
  for (const turn of steersByTurn.values()) {
    const steer = turn.get(uuid);
    if (steer?.query === query) steer.state = next;
  }
  for (const missed of missedByNativeThread.values()) {
    const steer = missed.find((candidate) => candidate.uuid === uuid);
    if (steer?.query === query) steer.state = next;
  }
};

const lifecycleStates = new Map<string, SteerState>([
  ["queued", "queued"],
  ["started", "taken"],
  ["completed", "taken"],
  ["cancelled", "cancelled"],
]);

/**
 * At each result of a steered turn the adapter doesn't hold for a person's steer: a clean
 * completion with an agent's steer still to run means Claude Code will run that steer as a turn
 * of its own. A failure never does, so its steers are dropped with the turn.
 */
export const j5NoteMissedClaudeSteers = (input: {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly nativeThreadId: string;
  readonly providerTurnId: string;
  readonly result: SDKResultMessage;
}): void => {
  // Missed steers Claude Code took during this turn ran in it, so no later turn is theirs.
  const pending = (missedByNativeThread.get(input.nativeThreadId) ?? []).filter(
    (steer) => steer.state !== "taken",
  );
  if (pending.length === 0) missedByNativeThread.delete(input.nativeThreadId);
  else missedByNativeThread.set(input.nativeThreadId, pending);
  const turn = steersByTurn.get(input.providerTurnId);
  steersByTurn.delete(input.providerTurnId);
  if (turn === undefined) return;
  const completed =
    input.result.subtype === "success" &&
    !input.result.is_error &&
    (input.result.terminal_reason === undefined || input.result.terminal_reason === "completed");
  if (!completed) return;
  const missed = [...turn.values()].filter(
    (steer) => steer.query === input.query && stillToRun(steer),
  );
  if (missed.length === 0) return;
  missedByNativeThread.set(input.nativeThreadId, [
    ...(missedByNativeThread.get(input.nativeThreadId) ?? []),
    ...missed,
  ]);
};

/**
 * When Claude Code starts a turn on its own, the first missed steer still live on this query is
 * what it is running, and its message becomes the run's. Missed steers Claude Code has already
 * taken alongside it ran in the same turn, so they are dropped.
 */
export const j5ClaimMissedClaudeSteer = (
  nativeThreadId: string,
  query: ClaudeAgentSdkQuerySession | undefined,
): MessageId | undefined => {
  const live = (missedByNativeThread.get(nativeThreadId) ?? []).filter(
    (steer) => steer.query === query && steer.state !== "cancelled",
  );
  const [claimed, ...rest] = live;
  const waiting = rest.filter((steer) => steer.state !== "taken");
  if (waiting.length === 0) missedByNativeThread.delete(nativeThreadId);
  else missedByNativeThread.set(nativeThreadId, waiting);
  if (claimed === undefined) return undefined;
  missedSteerTurns.add(claimed.messageId);
  return claimed.messageId as MessageId;
};

/** Whether this turn's message is a missed steer whose Claude Code turn is already running. */
export const j5IsMissedClaudeSteerTurn = (messageId: string): boolean =>
  missedSteerTurns.has(messageId);

/** Releases steers carrying these messages when a run ends without a clean SDK result. */
export const j5ForgetClaudeSteers = (messageIds: ReadonlyArray<string>): void => {
  const wanted = new Set(messageIds);
  for (const [providerTurnId, turn] of steersByTurn) {
    if ([...turn.values()].some((steer) => wanted.has(steer.messageId))) {
      steersByTurn.delete(providerTurnId);
    }
  }
  for (const [nativeThreadId, missed] of missedByNativeThread) {
    const kept = missed.filter((steer) => !wanted.has(steer.messageId));
    if (kept.length === 0) missedByNativeThread.delete(nativeThreadId);
    else missedByNativeThread.set(nativeThreadId, kept);
  }
  for (const messageId of wanted) missedSteerTurns.delete(messageId);
};

/**
 * Starts the run for a missed steer the Claude adapter claimed, by re-sending its message under
 * its own id, as upstream does for a steer that misses its turn. Returns false when the message
 * is gone, so the continuation falls back to upstream's notice.
 */
export const j5DispatchMissedClaudeSteer = Effect.fn("j5.a2a.claudeSteers.dispatchMissed")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const projection = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [messageId],
    });
    const message = projection.messages.find((candidate) => candidate.id === messageId);
    if (message === undefined) {
      missedSteerTurns.delete(messageId);
      return false;
    }
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:j5-missed-steer:${message.id}`),
      threadId,
      messageId: message.id,
      text: message.text,
      ...(message.context ? { context: message.context } : {}),
      attachments: message.attachments,
      dispatchMode: { type: "queue_after_active" },
      createdBy: message.createdBy,
      creationSource: message.creationSource,
      ...(message.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: message.scheduledTaskId }),
      ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    });
    return true;
  },
);
