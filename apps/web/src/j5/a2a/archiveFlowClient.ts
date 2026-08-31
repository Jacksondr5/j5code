import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

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

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));

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

export const readPreArchiveFactsEffect = Effect.fn("j5.a2a.archiveFlowClient.readFacts")(function* (
  threadId: ThreadId,
) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/pre-archive-facts"),
  ).pipe(HttpClientRequest.bodyJson({ threadId }));
  const response = yield* client.execute(request);
  const success = yield* requireSuccess(response);
  return yield* HttpClientResponse.schemaBodyJson(PreArchiveFacts)(success);
});

const readParticipantLabelsEffect = Effect.fn("j5.a2a.archiveFlowClient.readParticipantLabels")(
  function* (participantIds: ReadonlyArray<string>) {
    if (participantIds.length === 0) return new Map<string, string>();
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(
      resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/client-reads/participant-identities"),
    ).pipe(HttpClientRequest.bodyJson({ participantIds }));
    const response = yield* client.execute(request);
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
  function* (threadId: ThreadId) {
    const facts = yield* readPreArchiveFactsEffect(threadId);
    if (facts.state !== "registered") {
      return { facts, participantLabels: new Map<string, string>() } satisfies ArchivePreflight;
    }
    const ids = Array.from(
      new Set([
        ...facts.openExchanges.map((exchange) => exchange.counterpartyId),
        ...(facts.placementSubtree.state === "known" ? facts.placementSubtree.participantIds : []),
      ]),
    );
    const participantLabels = yield* readParticipantLabelsEffect(ids).pipe(
      Effect.orElseSucceed(() => new Map<string, string>()),
    );
    return { facts, participantLabels } satisfies ArchivePreflight;
  },
);

export const readArchivePreflight = (threadId: ThreadId): Promise<ArchivePreflight> =>
  runtime.runPromise(readArchivePreflightEffect(threadId));
