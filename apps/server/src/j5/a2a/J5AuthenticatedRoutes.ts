import * as Layer from "effect/Layer";

import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
import { layer as squadronManagementServiceLayer } from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { threadHomesHttpRouteLayer } from "./ThreadHomesHttp.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  humanInboxHttpRouteLayer,
  squadronHttpRouteLayer,
  threadHomesHttpRouteLayer,
).pipe(Layer.provide(squadronManagementServiceLayer));
