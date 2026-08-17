import * as Layer from "effect/Layer";

import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";

const ledgerProvided = ledgerLayer;
const deliveryTransportProvided = deliveryTransportLayer;
const sendServiceProvided = sendServiceLayer.pipe(Layer.provide(ledgerProvided));
const deliveryWorkerProvided = deliveryWorkerLayer.pipe(
  Layer.provide(ledgerProvided),
  Layer.provide(deliveryTransportProvided),
);

/** Production J5 A2A services; SQL and V2 thread management stay shared runtime dependencies. */
export const J5A2ARuntimeLayer = Layer.mergeAll(
  ledgerProvided,
  deliveryTransportProvided,
  sendServiceProvided,
  deliveryWorkerProvided,
);
