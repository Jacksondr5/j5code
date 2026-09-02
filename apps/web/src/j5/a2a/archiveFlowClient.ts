import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

const Urgency = Schema.NullOr(Schema.Literals(["blocking", "soon", "fyi"]));
const OpenExchange = Schema.Struct({
  squadronId: Schema.String,
  exchangeId: Schema.String,
  direction: Schema.Literals(["inbound", "outbound"]),
  replyObligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterpartyId: Schema.String,
  intent: Schema.String,
  urgency: Urgency,
  openedAt: Schema.String,
});
const PlacementSubtree = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unknown"),
    reason: Schema.Literal("placement-query-failed"),
  }),
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    state: Schema.Literal("known"),
    participantIds: Schema.Array(Schema.String).check(
      Schema.makeFilter(
        (participantIds) =>
          participantIds.length > 0 || "known placement subtrees include at least one participant",
      ),
    ),
  }),
]);
const PreArchiveFacts = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("not-an-a2a-participant"),
    threadId: ThreadId,
    openExchanges: Schema.Array(OpenExchange),
    placementSubtree: Schema.Struct({ state: Schema.Literal("not-applicable") }),
  }),
  Schema.Struct({
    state: Schema.Literal("registered"),
    threadId: ThreadId,
    squadronId: Schema.String,
    participantId: Schema.String,
    retired: Schema.Boolean,
    openExchanges: Schema.Array(OpenExchange),
    placementSubtree: PlacementSubtree,
  }),
]);
export type PreArchiveFacts = typeof PreArchiveFacts.Type;

const IdentityResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      participantId: Schema.String,
      identity: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("known"), displayName: Schema.String }),
        Schema.Struct({ kind: Schema.Literal("unknown") }),
      ]),
    }),
  ),
});

const ErrorResponse = Schema.Struct({ message: Schema.String });
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class PreArchiveFactsHttpError extends Schema.TaggedErrorClass<PreArchiveFactsHttpError>()(
  "PreArchiveFactsHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const requireSuccess = Effect.fn("j5.a2a.archiveFlowClient.requireSuccess")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new PreArchiveFactsHttpError({
    status: response.status,
    detail: decoded?.message ?? `Pre-archive fact request failed with status ${response.status}.`,
  });
});

const executeEnvironmentPost = Effect.fn("j5.a2a.archiveFlowClient.executeEnvironmentPost")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly pathname: string;
    readonly body: unknown;
  }) {
    const client = yield* HttpClient.HttpClient;
    const url = environmentEndpointUrl(input.prepared.httpBaseUrl, input.pathname);
    const request = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(input.body));
    const authorization = input.prepared.httpAuthorization;
    let authorizedRequest = request;
    if (authorization?._tag === "Bearer") {
      authorizedRequest = HttpClientRequest.bearerToken(request, authorization.token);
    } else if (authorization?._tag === "Dpop") {
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              new PreArchiveFactsHttpError({
                status: 0,
                detail: "Pre-archive fact request could not be authorized.",
              }),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
      const dpop = yield* signer
        .createProof({ method: "POST", url, accessToken: authorization.accessToken })
        .pipe(
          Effect.mapError(
            () =>
              new PreArchiveFactsHttpError({
                status: 0,
                detail: "Pre-archive fact request could not be authorized.",
              }),
          ),
        );
      authorizedRequest = HttpClientRequest.setHeaders(request, {
        authorization: `DPoP ${authorization.accessToken}`,
        dpop,
      });
    }
    return yield* authorization === null
      ? client
          .execute(authorizedRequest)
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
      : client.execute(authorizedRequest);
  },
);

export const readPreArchiveFactsEffect = Effect.fn("j5.a2a.archiveFlowClient.readFacts")(
  function* (input: {
    readonly threadRef: ScopedThreadRef;
    readonly prepared: PreparedConnection;
  }) {
    const response = yield* executeEnvironmentPost({
      prepared: input.prepared,
      pathname: "/api/j5/a2a/pre-archive-facts",
      body: { threadId: input.threadRef.threadId },
    });
    const success = yield* requireSuccess(response);
    return yield* HttpClientResponse.schemaBodyJson(PreArchiveFacts)(success);
  },
);

const readParticipantLabelsEffect = Effect.fn("j5.a2a.archiveFlowClient.readParticipantLabels")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly participantIds: ReadonlyArray<string>;
  }) {
    if (input.participantIds.length === 0) return new Map<string, string>();
    const response = yield* executeEnvironmentPost({
      prepared: input.prepared,
      pathname: "/api/j5/a2a/client-reads/participant-identities",
      body: { participantIds: input.participantIds },
    });
    const success = yield* requireSuccess(response);
    const decoded = yield* HttpClientResponse.schemaBodyJson(IdentityResponse)(success);
    return new Map(
      decoded.entries.flatMap((entry) =>
        entry.identity.kind === "known"
          ? [[entry.participantId, entry.identity.displayName] as const]
          : [],
      ),
    );
  },
);

export interface ArchivePreflight {
  readonly facts: PreArchiveFacts | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}

/** Facts remain useful without identity labels; literal participant ids are the honest fallback. */
export const readArchivePreflightEffect = Effect.fn("j5.a2a.archiveFlowClient.readPreflight")(
  function* (threadRef: ScopedThreadRef) {
    const prepared = readPreparedConnection(threadRef.environmentId);
    if (!prepared) {
      return yield* new PreArchiveFactsHttpError({
        status: 0,
        detail: "Pre-archive fact request could not reach the thread environment.",
      });
    }
    const facts = yield* readPreArchiveFactsEffect({ threadRef, prepared });
    if (facts.state !== "registered") {
      return { facts, participantLabels: new Map<string, string>() } satisfies ArchivePreflight;
    }
    const ids = Array.from(
      new Set([
        ...facts.openExchanges.map((exchange) => exchange.counterpartyId),
        ...(facts.placementSubtree.state === "known" ? facts.placementSubtree.participantIds : []),
      ]),
    );
    const participantLabels = yield* readParticipantLabelsEffect({
      prepared,
      participantIds: ids,
    }).pipe(Effect.orElseSucceed(() => new Map<string, string>()));
    return { facts, participantLabels } satisfies ArchivePreflight;
  },
);

export const readArchivePreflight = (threadRef: ScopedThreadRef): Promise<ArchivePreflight> =>
  runtime.runPromise(readArchivePreflightEffect(threadRef));
