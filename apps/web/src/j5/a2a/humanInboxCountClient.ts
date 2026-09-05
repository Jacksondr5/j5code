import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { HumanInboxHttpError } from "./humanInboxClient";

const OpenInboxCountResponse = Schema.Struct({
  personId: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));

export const readOpenInboxCountEffect = Effect.fn("j5.a2a.humanInboxCountClient.read")(function* (
  personId?: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/client-reads/open-count"),
  ).pipe(HttpClientRequest.bodyJson(personId === undefined ? {} : { personId }));
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* new HumanInboxHttpError({
      status: response.status,
      detail: `Inbox count request failed with status ${response.status}.`,
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(OpenInboxCountResponse)(response);
});

export const readOpenInboxCount = (personId?: string) =>
  runtime.runPromise(readOpenInboxCountEffect(personId));
