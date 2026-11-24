import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { ClientActionsService } from "../a2a/ClientActionsService.ts";
import { ClientReadsService } from "../a2a/ClientReadsService.ts";
import { EnvironmentLinkService } from "../a2a/EnvironmentLinkService.ts";
import { PeerAdminService } from "../a2a/PeerAdminService.ts";
import { ReadChanges } from "../a2a/ReadChanges.ts";
import { ArtifactDeletion } from "../artifacts/ArtifactDeletion.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";
import { Access } from "../sharing/Access.ts";
import { Links } from "../sharing/Links.ts";
import { People } from "../sharing/People.ts";
import { PersonAccess } from "../sharing/PersonAccess.ts";
import { SharedConversation } from "../sharing/SharedConversation.ts";
import { SharedThreads } from "../sharing/SharedThreads.ts";

/** What a connection's upstream handlers read: a service session gets upstream's own answers. */
export const layerJ5ConnectionServices = Layer.mergeAll(
  Layer.mock(PersonAccess)({ sessionReach: () => Effect.succeed({ kind: "service" }) }),
  Layer.mock(SharedConversation)({}),
);

/**
 * The J5 services `ws.ts` reads when it builds its route, for upstream tests that serve the
 * whole socket and call none of J5's RPCs.
 */
export const layerJ5WsRouteServices = Layer.mergeAll(
  layerJ5ConnectionServices,
  Layer.mock(AgentCrewInstanceService)({}),
  Layer.mock(PlaybookStore)({}),
  Layer.mock(ClientActionsService)({}),
  Layer.mock(ClientReadsService)({}),
  Layer.mock(PeerAdminService)({}),
  Layer.mock(EnvironmentLinkService)({}),
  Layer.mock(ReadChanges)({}),
  Layer.mock(ArtifactDeletion)({}),
  Layer.mock(People)({}),
  Layer.mock(Links)({}),
  Layer.mock(Access)({}),
  Layer.mock(SharedThreads)({}),
);
