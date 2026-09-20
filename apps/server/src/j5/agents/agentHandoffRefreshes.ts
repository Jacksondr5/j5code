import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Revision counter bumped after every handoff row write. The run-finalization observer bumps it
 * inside the orchestration runtime; the J5 WebSocket handler streams its changes so clients hold
 * one environment-wide handoff query and refetch it only when a row changed. The single layer
 * instance is shared by reference between both providers.
 */
export class AgentHandoffRefreshes extends Context.Service<
  AgentHandoffRefreshes,
  SubscriptionRef.SubscriptionRef<number>
>()("t3/j5/agents/agentHandoffRefreshes") {}

export const layer = Layer.effect(AgentHandoffRefreshes, SubscriptionRef.make(0));

export const bumpAgentHandoffRefreshes = (refreshes: SubscriptionRef.SubscriptionRef<number>) =>
  SubscriptionRef.update(refreshes, (revision) => revision + 1);

/** Only revisions after the subscriber joined; the current value is not a change. */
export const agentHandoffRefreshChanges = (refreshes: SubscriptionRef.SubscriptionRef<number>) =>
  SubscriptionRef.changes(refreshes).pipe(Stream.drop(1));
