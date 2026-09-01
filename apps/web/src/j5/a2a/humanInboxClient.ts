import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
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
  senderThreadId: Schema.NullOr(Schema.String),
  intent: Schema.String,
  urgency: Schema.Literals(["blocking", "soon", "fyi"]),
  message: Schema.String,
  openedAt: Schema.String,
  status: Schema.Literals(["open", "answered"]),
  terminalAt: Schema.NullOr(Schema.String),
});
export type HumanInboxItem = typeof HumanInboxItem.Type;

const InboxResponse = Schema.Struct({
  personId: Schema.String,
  items: Schema.Array(HumanInboxItem),
});
export type HumanInboxResponse = typeof InboxResponse.Type;

const AnswerResponse = Schema.Struct({
  result: Schema.Struct({
    messageId: Schema.String,
    exchangeId: Schema.NullOr(Schema.String),
    exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
    joinedExistingExchange: Schema.Boolean,
    durableAtSeq: Schema.Number,
  }),
});

const ErrorResponse = Schema.Struct({ message: Schema.String });
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class HumanInboxHttpError extends Schema.TaggedErrorClass<HumanInboxHttpError>()(
  "HumanInboxHttpError",
  {
    status: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const requireHumanInboxSuccess = Effect.fn("j5.a2a.humanInboxClient.requireSuccess")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new HumanInboxHttpError({
    status: response.status,
    detail: decoded?.message ?? `Human inbox request failed with status ${response.status}.`,
  });
});

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));

export const listHumanInboxEffect = Effect.fn("j5.a2a.humanInboxClient.list")(function* (
  personId?: string,
  status: "open" | "answered" = "open",
) {
  const client = yield* HttpClient.HttpClient;
  const url = new URL(resolvePrimaryEnvironmentHttpUrl("/api/j5/a2a/inbox"));
  if (personId !== undefined) url.searchParams.set("personId", personId);
  url.searchParams.set("status", status);
  const response = yield* client.get(url.toString());
  const success = yield* requireHumanInboxSuccess(response);
  return yield* HttpClientResponse.schemaBodyJson(InboxResponse)(success);
});

export const listHumanInbox = (
  personId?: string,
  status: "open" | "answered" = "open",
): Promise<HumanInboxResponse> => runtime.runPromise(listHumanInboxEffect(personId, status));

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
      const success = yield* requireHumanInboxSuccess(response);
      return yield* HttpClientResponse.schemaBodyJson(AnswerResponse)(success);
    }),
  );
