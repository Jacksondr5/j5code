import { EnvironmentId, type PeerLinkError } from "@t3tools/contracts";
import {
  J5_LINK_SESSION_API_PATH,
  type ForgetEnvironmentLinkRequest,
  type ForgetEnvironmentLinkResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";

const LINK_SESSION_TIMEOUT = Duration.seconds(10);

/**
 * What J5 adds to a link this server holds: the other server is told which server holds the
 * link's session, and forgetting the link revokes that session there. Upstream's own forget
 * leaves the session live on the other server until someone revokes it.
 */
export class EnvironmentLinkService extends Context.Service<
  EnvironmentLinkService,
  {
    /** Revoke the session this server's link holds on the other, then forget the link here. */
    readonly forget: (
      input: ForgetEnvironmentLinkRequest,
    ) => Effect.Effect<ForgetEnvironmentLinkResponse, PeerLinkError>;
  }
>()("t3/j5/a2a/EnvironmentLinkService") {}

const makeServices = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const sessionRequest = (
    method: "PUT" | "DELETE",
    resolved: PeerLinks.ResolvedPeerLink,
    body?: unknown,
  ) =>
    httpClient
      .execute(
        HttpClientRequest.make(method)(`${resolved.url}${J5_LINK_SESSION_API_PATH}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${resolved.token}`),
          body === undefined
            ? (request) => request
            : HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
        ),
      )
      .pipe(Effect.timeout(LINK_SESSION_TIMEOUT));

  /** Best effort: a link whose session was never claimed still works, and still expires. */
  const claim = Effect.fn("j5.a2a.environmentLinks.claim")(
    function* (environmentId: EnvironmentId) {
      const resolved = yield* links.resolve(environmentId);
      const self = yield* environment.getEnvironmentId;
      const response = yield* sessionRequest("PUT", resolved, { environmentId: self });
      if (response.status !== 204) {
        yield* Effect.logWarning("A linked environment did not record this link's session", {
          environmentId,
          status: response.status,
        });
      }
    },
    Effect.ignoreCause({ log: true }),
  );

  const forget: EnvironmentLinkService["Service"]["forget"] = Effect.fn(
    "j5.a2a.environmentLinks.forget",
  )(function* (input) {
    const environmentId = EnvironmentId.make(input.environmentId);
    const resolved = yield* Effect.result(links.resolve(environmentId));
    let sessionRevoked = false;
    let detail: string | null = null;
    if (Result.isFailure(resolved)) {
      // An expired link's session expired with it, and an unknown link holds none.
      sessionRevoked =
        resolved.failure.reason === "expired" || resolved.failure.reason === "unknown_link";
      detail = sessionRevoked ? null : resolved.failure.message;
    } else {
      const label = resolved.success.link.label;
      const released = yield* Effect.result(sessionRequest("DELETE", resolved.success));
      if (Result.isSuccess(released) && released.success.status === 204) {
        sessionRevoked = true;
      } else if (Result.isSuccess(released) && released.success.status === 404) {
        detail = `${label} runs a version that cannot end a link's session when asked.`;
      } else {
        detail = `${label} did not confirm that it ended the link's session.`;
      }
    }
    const removed = yield* links.unlink(environmentId);
    return {
      removed,
      sessionRevoked,
      detail:
        detail === null
          ? null
          : `${detail} The session stays there until it runs out or is revoked in that server's Settings → Sharing & access.`,
    };
  });

  const link: PeerLinks.PeerLinks["Service"]["link"] = Effect.fn("j5.a2a.environmentLinks.link")(
    function* (input) {
      const linked = yield* links.link(input);
      yield* claim(linked.environmentId);
      return linked;
    },
  );
  const claimingLinks = PeerLinks.PeerLinks.of({ ...links, link });

  return Context.make(PeerLinks.PeerLinks, claimingLinks).pipe(
    Context.add(EnvironmentLinkService, EnvironmentLinkService.of({ forget })),
  );
});

/** Over whichever `PeerLinks` it is given: upstream's in the server, a stand-in under test. */
export const layerOver = Layer.effectContext(makeServices);

/**
 * Upstream's `PeerLinks` with every new link's session claimed, and J5's forget beside it. It
 * takes upstream's layer underneath, so every caller of `PeerLinks` gets the claiming one.
 */
export const layer = layerOver.pipe(Layer.provide(PeerLinks.layer));
