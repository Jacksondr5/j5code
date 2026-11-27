import * as Layer from "effect/Layer";

import { linkSessionHttpRouteLayer } from "./LinkSessionHttp.ts";
import { machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";
import { identityHttpRouteLayer } from "../identity/IdentityHttp.ts";
import { cliPairingHttpRouteLayer } from "../sharing/CliPairingHttp.ts";
import { guestProjectIconRouteLayer } from "../sharing/GuestProjectIcons.ts";
import { linkHttpRouteLayer } from "../sharing/LinkHttp.ts";
import { sessionRenewalRouteLayer } from "../sharing/SessionRenewal.ts";

/**
 * One authenticated J5 route aggregate, so new J5 HTTP routes add no upstream seam. Client reads
 * and acts are WebSocket RPCs (`wsRpc.ts`); these serve other servers, scripts, the `j5` CLI, and
 * artifact reads too large for the socket. Session renewal, links and J5 Connect sign-in need no
 * sign-in to J5: they trust their own tokens.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  artifactHttpRouteLayer,
  machineSenderHttpRouteLayer,
  peerHttpRouteLayer,
  linkSessionHttpRouteLayer,
  guestProjectIconRouteLayer,
  sessionRenewalRouteLayer,
  linkHttpRouteLayer,
  cliPairingHttpRouteLayer,
  identityHttpRouteLayer,
).pipe(Layer.provide(artifactWorkspaceLayer));
