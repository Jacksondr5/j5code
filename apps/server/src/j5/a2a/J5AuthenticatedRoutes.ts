import * as Layer from "effect/Layer";

import {
  CLIENT_READS_OPEN_COUNT_PATH,
  CLIENT_READS_PARTICIPANT_HOMES_PATH,
  CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
  makeClientReadsHttpRouteLayer,
} from "./ClientReadsHttp.ts";
import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
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
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  artifactHttpRouteLayer,
  humanInboxHttpRouteLayer,
  preArchiveFactsHttpRouteLayer,
  squadronHttpRouteLayer,
  threadHomesHttpRouteLayer,
  makeClientReadsHttpRouteLayer({
    participantHome: CLIENT_READS_PARTICIPANT_HOMES_PATH,
    participantIdentities: CLIENT_READS_PARTICIPANT_IDENTITIES_PATH,
    openInboxCount: CLIENT_READS_OPEN_COUNT_PATH,
  }),
).pipe(Layer.provide(artifactWorkspaceLayer), Layer.provide(squadronManagementServiceLayer));
