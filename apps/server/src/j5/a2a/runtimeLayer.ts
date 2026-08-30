import * as Layer from "effect/Layer";

import {
  layer as archiveFactsLayer,
  placementFactsUnavailableLayer,
} from "./ArchiveFactsService.ts";
import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { layer as homeRegistrarLayer } from "./HomeRegistrar.ts";
import { humanPersonRegistryLayer } from "./HumanPersonRegistry.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as participantPlacementLayer } from "./PlacementService.ts";
import { layer as lifecycleServiceLayer } from "./LifecycleService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";
import { layer as silenceDetectorLayer } from "./SilenceDetector.ts";
import { layer as humanInboxLayer } from "./HumanInboxService.ts";
import { layer as squadronProjectReferencesLayer } from "./SquadronProjectReferences.ts";
import { layer as squadronThreadCreationServiceLayer } from "./SquadronThreadCreationService.ts";

/**
 * The durable launch engine needs this subset before it can start preparing a
 * worktree. It has no ThreadManagement dependency, so production can provide
 * it to ThreadLaunch once and the authenticated route graph can reuse it.
 */
export const makeJ5SquadronCreationLayer = (
  options: { readonly ledger?: typeof ledgerLayer } = {},
) => {
  const ledgerProvided = options.ledger ?? ledgerLayer;
  const registrarAndReferences = Layer.mergeAll(homeRegistrarLayer, squadronProjectReferencesLayer);
  return squadronThreadCreationServiceLayer.pipe(
    Layer.provideMerge(registrarAndReferences),
    Layer.provideMerge(ledgerProvided),
  );
};

export const J5SquadronCreationLayer = makeJ5SquadronCreationLayer();

export const makeJ5A2AAuxiliaryLayer = (
  options: { readonly deliveryTransport?: typeof deliveryTransportLayer } = {},
) => {
  const deliveryTransportProvided = options.deliveryTransport ?? deliveryTransportLayer;
  const deliveryWorkerProvided = deliveryWorkerLayer.pipe(
    Layer.provideMerge(deliveryTransportProvided),
  );
  const silenceDetectorProvided = silenceDetectorLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const lifecycleServiceProvided = lifecycleServiceLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const archiveFactsProvided = archiveFactsLayer.pipe(
    Layer.provide(placementFactsUnavailableLayer),
  );
  return Layer.mergeAll(
    humanPersonRegistryLayer,
    sendServiceLayer,
    deliveryWorkerProvided,
    silenceDetectorProvided,
    humanInboxLayer,
    participantPlacementLayer,
    lifecycleServiceProvided,
    archiveFactsProvided,
  );
};

export const makeJ5A2ARuntimeLayer = (
  options: {
    readonly ledger?: typeof ledgerLayer;
    readonly deliveryTransport?: typeof deliveryTransportLayer;
  } = {},
) => {
  const squadronCreationProvided = makeJ5SquadronCreationLayer(
    options.ledger === undefined ? {} : { ledger: options.ledger },
  );
  return makeJ5A2AAuxiliaryLayer(
    options.deliveryTransport === undefined ? {} : { deliveryTransport: options.deliveryTransport },
  ).pipe(Layer.provideMerge(squadronCreationProvided));
};

/** Production J5 A2A services; SQL and V2 thread management stay shared dependencies. */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer();
export const J5A2AAuxiliaryLayer = makeJ5A2AAuxiliaryLayer();
