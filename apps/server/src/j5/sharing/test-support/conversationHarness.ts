import type { OrchestrationV2Command, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "../../../orchestration-v2/EventSink.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import { A2ALifecycleService } from "../../a2a/LifecycleService.ts";
import * as Access from "../Access.ts";
import * as SharedConversation from "../SharedConversation.ts";
import * as SharedThreads from "../SharedThreads.ts";
import { recordsLayer } from "./accessHarness.ts";

/**
 * The commands the platform handed upstream, and upstream's event log: the history it held when
 * the server started, then what it logs live, with how many history events were read.
 */
export class Upstream extends Context.Service<
  Upstream,
  {
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
    readonly history: ReadonlyArray<OrchestrationV2StoredEvent>;
    readonly historyRead: Ref.Ref<number>;
    readonly live: Queue.Queue<OrchestrationV2StoredEvent>;
  }
>()("t3/j5/sharing/test-support/conversationHarness/Upstream") {}

const upstreamLayer = (history: ReadonlyArray<OrchestrationV2StoredEvent>) =>
  Layer.effect(
    Upstream,
    Effect.gen(function* () {
      return Upstream.of({
        dispatched: yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]),
        history,
        historyRead: yield* Ref.make(0),
        live: yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
      });
    }),
  );

const threadsLayer = Layer.effect(
  ThreadManagementService,
  Effect.map(Upstream, (upstream) => {
    // As upstream's event sink streams: the logged history after the sequence, then live.
    const streamFrom = (afterSequence: number) =>
      Stream.fromIterable(upstream.history).pipe(
        Stream.filter((stored) => stored.sequence > afterSequence),
        Stream.tap(() => Ref.update(upstream.historyRead, (read) => read + 1)),
        Stream.concat(Stream.fromQueue(upstream.live)),
      );
    return ThreadManagementService.of({
      dispatch: (command: OrchestrationV2Command) =>
        Ref.update(upstream.dispatched, (sent) => [...sent, command]).pipe(Effect.as({} as never)),
      streamStoredEvents: streamFrom(0),
      streamStoredEventsFrom: (input?: {
        readonly afterSequence?: number;
        readonly eventType?: OrchestrationV2StoredEvent["event"]["type"];
      }) =>
        streamFrom(input?.afterSequence ?? 0).pipe(
          Stream.filter(
            (stored) => input?.eventType === undefined || stored.event.type === input.eventType,
          ),
        ),
    } as unknown as ThreadManagementService["Service"]);
  }),
);

const eventSinkLayer = Layer.effect(
  EventSinkV2,
  Effect.map(Upstream, (upstream) =>
    EventSinkV2.of({
      latestSequence: () =>
        Effect.succeed(Math.max(0, ...upstream.history.map((stored) => stored.sequence))),
    } as unknown as EventSinkV2["Service"]),
  ),
);

/**
 * The asks lifecycle, ending nothing: a test of who may answer an ask builds the real one over
 * a ledger (`everyoneHere.test.ts`).
 */
export const quietLifecycleLayer = Layer.mock(A2ALifecycleService)({
  endAsksOf: () => Effect.succeed([]),
});

/**
 * People, levels, devices and the access core, with shared conversations over them and the
 * write hook that records a thread shared, over one in-memory database. Upstream's log starts
 * with `history`.
 */
export const conversationLayerWith = (history: ReadonlyArray<OrchestrationV2StoredEvent>) =>
  SharedConversation.layer.pipe(
    Layer.provideMerge(SharedThreads.layer),
    Layer.provide(quietLifecycleLayer),
    Layer.provide(Layer.merge(threadsLayer, eventSinkLayer)),
    Layer.provideMerge(upstreamLayer(history)),
    Layer.provideMerge(ProviderRegistryMock.layer()),
    Layer.provideMerge(
      Access.layer.pipe(
        Layer.provide(SharedThreads.accessWriteHookLayer),
        Layer.provideMerge(recordsLayer),
      ),
    ),
  );

export const conversationLayer = conversationLayerWith([]);

/** An access core no one changes, for a runtime built without people. */
export const quietAccessLayer = Layer.mock(Access.Access)({
  subscribe: PubSub.unbounded<Access.AccessChange>().pipe(Effect.flatMap(PubSub.subscribe)),
});
