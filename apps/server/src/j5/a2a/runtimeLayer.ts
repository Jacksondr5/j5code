import * as Layer from "effect/Layer";

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
  // Retain the unexposed cascade engine in the production graph for the future
  // Crew command consumer. It requires the one shared upstream lifecycle
  // service; no fallback constructs a second instance, and no current MCP tool
  // or handler reaches this service.
  const placementCascadeProvided = placementCascadeLayer.pipe(
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

/** Production J5 A2A services; SQL and V2 thread/lifecycle services stay shared dependencies. */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer();
