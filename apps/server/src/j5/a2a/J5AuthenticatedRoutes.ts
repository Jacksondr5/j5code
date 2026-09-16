import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

import {
  CLIENT_READS_OPEN_COUNT_PATH,
  CLIENT_READS_PARTICIPANT_HOMES_PATH,
  CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
  makeClientReadsHttpRouteLayer,
} from "./ClientReadsHttp.ts";
import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
import { machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import { preArchiveFactsHttpRouteLayer } from "./PreArchiveFactsHttp.ts";
import { layer as squadronManagementServiceLayer } from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { threadHomesHttpRouteLayer } from "./ThreadHomesHttp.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam.
 */
// The peer registry reaches other servers, so it carries its own HTTP client and
// this server's identity rather than widening the shared A2A runtime layer. The
// identity reads the same environment-id file the server publishes at startup.
const serverIdentityLayer = ServerEnvironment.identityLayer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(NodeServices.layer),
);
const peerRoutesProvided = peerHttpRouteLayer.pipe(
  Layer.provide(peerRegistryLayer.pipe(Layer.provide(FetchHttpClient.layer))),
  Layer.provide(serverIdentityLayer),
);

export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  artifactHttpRouteLayer,
  humanInboxHttpRouteLayer,
  machineSenderHttpRouteLayer,
  peerRoutesProvided,
  preArchiveFactsHttpRouteLayer,
  squadronHttpRouteLayer,
  threadHomesHttpRouteLayer,
  makeClientReadsHttpRouteLayer({
    participantHome: CLIENT_READS_PARTICIPANT_HOMES_PATH,
    participantIdentities: CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
    openInboxCount: CLIENT_READS_OPEN_COUNT_PATH,
  }),
).pipe(Layer.provide(artifactWorkspaceLayer), Layer.provide(squadronManagementServiceLayer));
