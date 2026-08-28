import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { browserCryptoLayer } from "../../cloud/dpop";

const HumanInboxItem = Schema.Struct({
  personId: Schema.String,
  squadronId: Schema.String,
  squadronName: Schema.String,
  exchangeId: Schema.String,
  senderId: Schema.String,
  intent: Schema.String,
  urgency: Schema.Literals(["blocking", "soon", "fyi"]),
  message: Schema.String,
  openedAt: Schema.String,
});
export type HumanInboxItem = typeof HumanInboxItem.Type;

const InboxResponse = Schema.Struct({ items: Schema.Array(HumanInboxItem) });

const AnswerResponse = Schema.Struct({
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));

export const listHumanInbox = (personId: string): Promise<ReadonlyArray<HumanInboxItem>> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const url = new URL(resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/inbox"));
      url.searchParams.set("personId", personId);
      const response = yield* client.get(url.toString());
      const success = yield* HttpClientResponse.filterStatusOk(response);
      return (yield* HttpClientResponse.schemaBodyJson(InboxResponse)(success)).items;
    }),
  );

export const answerHumanExchange = (input: {
  readonly personId: string;
  readonly exchangeId: string;
  readonly message: string;
  readonly clientRequestId: string;
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/inbox/answer"),
      ).pipe(HttpClientRequest.bodyJson(input));
      const response = yield* client.execute(request);
      const success = yield* HttpClientResponse.filterStatusOk(response);
      return yield* HttpClientResponse.schemaBodyJson(AnswerResponse)(success);
    }),
  );
