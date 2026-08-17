import * as Layer from "effect/Layer";

import { layer as threadLifecycleLayer } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { layer as homeRegistrarLayer } from "./HomeRegistrar.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as placementCascadeLayer } from "./PlacementCascadeService.ts";
import { layer as participantPlacementLayer } from "./PlacementService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";
import { layer as silenceDetectorLayer } from "./SilenceDetector.ts";

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
    Layer.provide(threadLifecycleLayer),
    Layer.provideMerge(participantPlacementLayer),
  );

  return Layer.mergeAll(
    homeRegistrarLayer,
    sendServiceLayer,
    deliveryWorkerProvided,
    silenceDetectorProvided,
    placementCascadeProvided,
  ).pipe(Layer.provideMerge(ledgerProvided));
};

/** Production J5 A2A services; SQL and V2 thread management stay shared runtime dependencies. */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer();
