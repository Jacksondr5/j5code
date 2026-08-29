import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLifecycle from "../../orchestration-v2/ThreadLifecycleService.ts";
import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { layer as homeRegistrarLayer } from "./HomeRegistrar.ts";
import { humanPersonRegistryLayer } from "./HumanPersonRegistry.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as placementCascadeLayer } from "./PlacementCascadeService.ts";
import { layer as participantPlacementLayer } from "./PlacementService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";
import { layer as silenceDetectorLayer } from "./SilenceDetector.ts";
import { layer as humanInboxLayer } from "./HumanInboxService.ts";

const sharedThreadLifecycleOrStandaloneFallback = Layer.effect(
  ThreadLifecycle.ThreadLifecycleService,
  Effect.gen(function* () {
    const shared = yield* Effect.serviceOption(ThreadLifecycle.ThreadLifecycleService);
    // Production supplies the V2 runtime's shared service. The fallback keeps
    // isolated toolkit/listing layers buildable from ThreadManagement alone.
    return Option.isSome(shared) ? shared.value : yield* ThreadLifecycle.make;
  }),
);

export const makeJ5A2ARuntimeLayer = (
  options: {
    readonly ledger?: typeof ledgerLayer;
    readonly deliveryTransport?: typeof deliveryTransportLayer;
  } = {},
) => {
  const ledgerProvided = options.ledger ?? ledgerLayer;
  const deliveryTransportProvided = options.deliveryTransport ?? deliveryTransportLayer;
  const deliveryWorkerProvided = deliveryWorkerLayer.pipe(
    Layer.provideMerge(deliveryTransportProvided),
  );
  const silenceDetectorProvided = silenceDetectorLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const placementCascadeProvided = placementCascadeLayer.pipe(
    Layer.provide(sharedThreadLifecycleOrStandaloneFallback),
    Layer.provideMerge(participantPlacementLayer),
  );

  return Layer.mergeAll(
    humanPersonRegistryLayer,
    homeRegistrarLayer,
    sendServiceLayer,
    deliveryWorkerProvided,
    silenceDetectorProvided,
    humanInboxLayer,
    placementCascadeProvided,
  ).pipe(Layer.provideMerge(ledgerProvided));
};

/** Production J5 A2A services; SQL and V2 thread management stay shared runtime dependencies. */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer();
