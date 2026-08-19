import * as Layer from "effect/Layer";

import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { layer as homeRegistrarLayer } from "./HomeRegistrar.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
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

  return Layer.mergeAll(
    homeRegistrarLayer,
    sendServiceLayer,
    deliveryWorkerProvided,
    silenceDetectorProvided,
  ).pipe(Layer.provideMerge(ledgerProvided));
};

/** Production J5 A2A services; SQL and V2 thread management stay shared runtime dependencies. */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer();
