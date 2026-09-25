import * as Layer from "effect/Layer";
import { playbookStoreLayer } from "../playbooks/PlaybookStore.ts";

import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";
import { layer as agentCrewInstanceLayer } from "./AgentCrewInstanceService.ts";
import { layer as archiveFactsLayer, placementFactsLayer } from "./ArchiveFactsService.ts";
import { layer as archiveAgentLayer } from "./ArchiveAgentService.ts";
import { layer as archiveCrewLayer } from "./ArchiveCrewService.ts";
import { layer as agentCrewProposalLayer } from "./AgentCrewProposalService.ts";
import { manualLayer as crewLaunchReporterLayer } from "./CrewLaunchReporter.ts";
import { layer as crewLaunchLayer } from "./CrewLaunchService.ts";
import { layer as crewProposalLayer } from "./CrewProposalService.ts";
import { layer as crewSeatFinishNotifierLayer } from "./CrewSeatFinishNotifier.ts";
import { layer as captainArchiveCascadeLayer } from "./CrewCaptainArchiveCascade.ts";
import { layer as crewStopLayer } from "./CrewStopService.ts";
import { layer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import {
  layer as homeRegistrarLayer,
  transactionLayer as homeRegistrationTransactionLayer,
} from "./HomeRegistrar.ts";
import { humanPersonRegistryLayer } from "./HumanPersonRegistry.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { layer as participantPlacementLayer } from "./PlacementService.ts";
import { layer as lifecycleServiceLayer } from "./LifecycleService.ts";
import { layer as machineParticipantLayer } from "./MachineParticipantService.ts";
import { layer as rosterLayer } from "./RosterService.ts";
import { layer as sendServiceLayer } from "./SendService.ts";
import { layer as silenceDetectorLayer } from "./SilenceDetector.ts";
import { layer as humanInboxLayer } from "./HumanInboxService.ts";
import { layer as clientReadsLayer } from "./ClientReadsService.ts";
import { layer as squadronProjectReferencesLayer } from "./SquadronProjectReferences.ts";
import { layer as squadronThreadCreationServiceLayer } from "./SquadronThreadCreationService.ts";
import { layer as threadHomesServiceLayer } from "./ThreadHomesService.ts";
import { layer as spawnCompositionLayer } from "./SpawnCompositionService.ts";
import { layer as squadronJoinLayer } from "./SquadronJoinService.ts";
import { layer as agentHandoffNudgeQueueLayer } from "../agents/agentHandoffNudgeQueue.ts";
import { layer as agentHandoffNudgeWorkerLayer } from "../agents/agentHandoffNudgeWorker.ts";
import { layer as agentHandoffRefreshesLayer } from "../agents/agentHandoffRefreshes.ts";

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
  return Layer.merge(squadronThreadCreationServiceLayer, spawnCompositionLayer).pipe(
    Layer.provideMerge(homeRegistrationTransactionLayer),
    Layer.provideMerge(participantPlacementLayer),
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
  // The detector reads Crew membership to stay quiet about a seat failure its Captain hears elsewhere.
  const silenceDetectorProvided = silenceDetectorLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  const lifecycleServiceProvided = lifecycleServiceLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const archiveFactsProvided = archiveFactsLayer.pipe(Layer.provide(placementFactsLayer));
  const squadronJoinProvided = squadronJoinLayer.pipe(
    Layer.provideMerge(homeRegistrationTransactionLayer),
  );
  // The saved-agent handoff worker drains the queue the run-finalization observer fills; the
  // queue layer is the same instance server.ts provides to that observer.
  const agentHandoffNudgeWorkerProvided = agentHandoffNudgeWorkerLayer.pipe(
    Layer.provide(agentHandoffNudgeQueueLayer),
  );
  const archiveAgentProvided = archiveAgentLayer.pipe(
    Layer.provideMerge(lifecycleServiceProvided),
    Layer.provideMerge(archiveFactsProvided),
  );
  const archiveCrewProvided = archiveCrewLayer.pipe(
    Layer.provideMerge(archiveAgentProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  const crewLaunchProvided = crewLaunchLayer.pipe(Layer.provideMerge(agentCrewInstanceLayer));
  // The report watches the seats an approval launched and tells the Captain how they started; the
  // finish notifier's stream feeds it, so one stream serves every Crew reaction.
  const crewLaunchReporterProvided = crewLaunchReporterLayer.pipe(
    Layer.provideMerge(agentCrewProposalLayer),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  const crewStopProvided = crewStopLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(archiveFactsProvided),
  );
  const crewProposalProvided = crewProposalLayer.pipe(
    Layer.provideMerge(crewLaunchProvided),
    Layer.provideMerge(crewLaunchReporterProvided),
  );
  // A person's archive of a Captain retires its Crews from the same event stream the notifier reads.
  const captainArchiveCascadeProvided = captainArchiveCascadeLayer.pipe(
    Layer.provideMerge(archiveCrewProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  // The finish notifier tells a Captain when a seat's handoff file appears, so it reads the workspace.
  const crewSeatFinishNotifierProvided = crewSeatFinishNotifierLayer.pipe(
    Layer.provideMerge(crewLaunchReporterProvided),
    Layer.provideMerge(captainArchiveCascadeProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provide(artifactWorkspaceLayer),
  );
  const runtimeWithoutClientReads = Layer.mergeAll(
    playbookStoreLayer,
    agentHandoffNudgeWorkerProvided,
    // Exported to the routes so the J5 WebSocket handler streams the same revision counter the
    // observer bumps (server.ts provides this layer object to the observer; Effect memoizes it).
    agentHandoffRefreshesLayer,
    humanPersonRegistryLayer,
    machineParticipantLayer,
    rosterLayer,
    sendServiceLayer,
    deliveryWorkerProvided,
    silenceDetectorProvided,
    humanInboxLayer,
    lifecycleServiceProvided,
    archiveFactsProvided,
    threadHomesServiceLayer,
    squadronJoinProvided,
    agentCrewInstanceLayer,
    archiveCrewProvided,
    crewProposalProvided,
    crewStopProvided,
    crewSeatFinishNotifierProvided,
  );
  return clientReadsLayer.pipe(Layer.provideMerge(runtimeWithoutClientReads));
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
