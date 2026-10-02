import * as Layer from "effect/Layer";
import { OrchestrationV2EventSinkLayerLive } from "../../orchestration-v2/runtimeLayer.ts";
import { layer as playbookCrewRelayLayer } from "../playbooks/PlaybookCrewRelay.ts";
import { playbookStoreLayer } from "../playbooks/PlaybookStore.ts";
import { FetchHttpClient } from "effect/unstable/http";

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
import { layer as crewRuntimeRequestLayer } from "./CrewRuntimeRequestService.ts";
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
import { layer as peerDirectoryLayer } from "./PeerDirectory.ts";
import { layer as peerInboundLayer } from "./PeerInboundService.ts";
import { layer as peerStoreLayer } from "./PeerStoreService.ts";
import { layer as peerPollerLayer } from "./PeerPoller.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
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

// Peering reaches other servers, so its layers carry their own HTTP client.
// This server's identity and name come from the server's own environment
// descriptor, the one its clients read. The registry is built once here and
// shared by the outbound transport, the peer directory the send service
// resolves through, and the peer routes.
// One HTTP client serves every layer that reaches a peer.
const peerHttpClient = FetchHttpClient.layer;
const peerRegistryProvided = peerRegistryLayer.pipe(Layer.provide(peerHttpClient));
const peerDirectoryProvided = peerDirectoryLayer.pipe(
  Layer.provide(peerRegistryProvided),
  Layer.provide(peerHttpClient),
);

/** The production transport with its peer side satisfied; tests substitute a transport layer of their own. */
const deliveryTransportWithPeers = deliveryTransportLayer.pipe(
  Layer.provide(peerRegistryProvided),
  Layer.provide(peerHttpClient),
);

export const makeJ5A2AAuxiliaryLayer = (
  options: { readonly deliveryTransport?: typeof deliveryTransportWithPeers } = {},
) => {
  const deliveryTransportProvided = options.deliveryTransport ?? deliveryTransportWithPeers;
  const sendServiceProvided = sendServiceLayer.pipe(Layer.provide(peerDirectoryProvided));
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
  // A polling peer's messages are handed out by the worker that owns their rows.
  const peerStoreProvided = peerStoreLayer.pipe(Layer.provideMerge(deliveryWorkerProvided));
  // A peer this server polls is polled from the moment the server starts.
  const peerPollerProvided = peerPollerLayer.pipe(
    Layer.provideMerge(deliveryWorkerProvided),
    Layer.provide(peerInboundLayer),
    Layer.provide(rosterLayer),
    Layer.provide(peerHttpClient),
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
  // Archiving a Crew cancels its playbook run through the one store object, so the store's
  // permit and revision are never duplicated.
  const archiveCrewProvided = archiveCrewLayer.pipe(
    Layer.provideMerge(archiveAgentProvided),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(playbookStoreLayer),
  );
  // Hands each landing of a Crew-linked run to the seat that owns it, inside the Captain's step
  // calls; a pending hand-off is finished by the Captain's next or retried call.
  const playbookCrewRelayProvided = playbookCrewRelayLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(playbookStoreLayer),
  );
  const crewLaunchProvided = crewLaunchLayer.pipe(Layer.provideMerge(agentCrewInstanceLayer));
  // The report watches the seats an approval launched and tells the Captain how they started; the
  // finish notifier's stream feeds it, so one stream serves every Crew reaction.
  // Both Crew reactions raise failure alerts, which wake the one delivery worker after committing.
  const crewLaunchReporterProvided = crewLaunchReporterLayer.pipe(
    Layer.provideMerge(playbookStoreLayer),
    Layer.provideMerge(agentCrewProposalLayer),
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(deliveryWorkerProvided),
  );
  const crewStopProvided = crewStopLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
    Layer.provideMerge(archiveFactsProvided),
  );
  // Provider approvals and questions on live Crew threads, read and answered from the Inbox.
  const crewRuntimeRequestProvided = crewRuntimeRequestLayer.pipe(
    Layer.provideMerge(agentCrewInstanceLayer),
  );
  // A playbook Crew is validated against the live YAML through the same store the tools use.
  const crewProposalProvided = crewProposalLayer.pipe(
    Layer.provideMerge(crewLaunchProvided),
    Layer.provideMerge(crewLaunchReporterProvided),
    Layer.provideMerge(playbookStoreLayer),
  );
  // A Captain's lifecycle carries its Crews, read from the same event stream the notifier reads.
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
    playbookCrewRelayProvided,
    agentHandoffNudgeWorkerProvided,
    // Exported to the routes so the J5 WebSocket handler streams the same revision counter the
    // observer bumps (server.ts provides this layer object to the observer; Effect memoizes it).
    agentHandoffRefreshesLayer,
    humanPersonRegistryLayer,
    machineParticipantLayer,
    peerDirectoryProvided,
    peerInboundLayer,
    peerStoreProvided,
    peerPollerProvided,
    rosterLayer,
    sendServiceProvided,
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
    crewRuntimeRequestProvided,
    crewSeatFinishNotifierProvided,
  ).pipe(Layer.provideMerge(peerRegistryProvided));
  return clientReadsLayer.pipe(Layer.provideMerge(runtimeWithoutClientReads));
};

export const makeJ5A2ARuntimeLayer = (
  options: {
    readonly ledger?: typeof ledgerLayer;
    readonly deliveryTransport?: typeof deliveryTransportWithPeers;
  } = {},
) => {
  const squadronCreationProvided = makeJ5SquadronCreationLayer(
    options.ledger === undefined ? {} : { ledger: options.ledger },
  );
  return makeJ5A2AAuxiliaryLayer(
    options.deliveryTransport === undefined ? {} : { deliveryTransport: options.deliveryTransport },
  ).pipe(Layer.provideMerge(squadronCreationProvided));
};

/**
 * Production J5 A2A services; SQL and V2 thread management stay shared dependencies. The event
 * sink is the orchestration runtime's own layer object, so Effect memoizes one instance; the
 * stream daemons read its latest sequence as their start point.
 */
export const J5A2ARuntimeLayer = makeJ5A2ARuntimeLayer().pipe(
  Layer.provide(OrchestrationV2EventSinkLayerLive),
);
export const J5A2AAuxiliaryLayer = makeJ5A2AAuxiliaryLayer().pipe(
  Layer.provide(OrchestrationV2EventSinkLayerLive),
);
