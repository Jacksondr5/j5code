import * as Layer from "effect/Layer";

import { humanInboxHttpRouteLayer } from "./HumanInboxHttp.ts";
import { layer as squadronManagementServiceLayer } from "./SquadronManagementService.ts";
import { squadronHttpRouteLayer } from "./SquadronHttp.ts";
import { layer as squadronProjectReferencesLayer } from "./SquadronProjectReferences.ts";
import { layer as squadronThreadCreationServiceLayer } from "./SquadronThreadCreationService.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  humanInboxHttpRouteLayer,
  squadronHttpRouteLayer,
).pipe(
  Layer.provide(squadronThreadCreationServiceLayer),
  Layer.provide(squadronManagementServiceLayer),
  Layer.provide(squadronProjectReferencesLayer),
);
