import * as Layer from "effect/Layer";
import { playbookHttpRouteLayer } from "../playbooks/PlaybookHttp.ts";
import { playbookLibraryHttpRouteLayer } from "../playbooks/PlaybookLibraryHttp.ts";

import { agentCrewReadsHttpRouteLayer } from "./AgentCrewReadsHttp.ts";
import { crewArchiveHttpRouteLayer } from "./CrewArchiveHttp.ts";
import { crewProposalsHttpRouteLayer } from "./CrewProposalsHttp.ts";
import { crewStopHttpRouteLayer } from "./CrewStopHttp.ts";
import { crewRuntimeRequestsHttpRouteLayer } from "./CrewRuntimeRequestsHttp.ts";
import { fleetReadsHttpRouteLayer } from "./FleetReadsHttp.ts";
import { spawnedChildrenHttpRouteLayer } from "./SpawnedChildrenHttp.ts";
import {
  CLIENT_READS_OPEN_COUNT_PATH,
  CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
  makeClientReadsHttpRouteLayer,
} from "./ClientReadsHttp.ts";
import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
import { machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { preArchiveFactsHttpRouteLayer } from "./PreArchiveFactsHttp.ts";
import { layer as agentHandoffArtifactDeleteLayer } from "../agents/agentHandoffArtifactDelete.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  agentCrewReadsHttpRouteLayer,
  crewArchiveHttpRouteLayer,
  crewProposalsHttpRouteLayer,
  crewStopHttpRouteLayer,
  crewRuntimeRequestsHttpRouteLayer,
  fleetReadsHttpRouteLayer,
  spawnedChildrenHttpRouteLayer,
  playbookHttpRouteLayer,
  playbookLibraryHttpRouteLayer,
  artifactHttpRouteLayer,
  humanInboxHttpRouteLayer,
  machineSenderHttpRouteLayer,
  peerHttpRouteLayer,
  preArchiveFactsHttpRouteLayer,
  makeClientReadsHttpRouteLayer({
    participantIdentities: CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
    openInboxCount: CLIENT_READS_OPEN_COUNT_PATH,
  }),
).pipe(Layer.provide(artifactWorkspaceLayer), Layer.provide(agentHandoffArtifactDeleteLayer));
