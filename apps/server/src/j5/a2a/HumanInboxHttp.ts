import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { A2ADeliveryWorker, manualLayer as manualDeliveryWorkerLayer } from "./DeliveryWorker.ts";
import { live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { CommCommandId, ExchangeId, ParticipantId } from "./contracts.ts";

const INBOX_PATH = "/api/j5/a2a/inbox";
const ANSWER_PATH = "/api/j5/a2a/inbox/answer";

const AnswerRequest = Schema.Struct({
  personId: ParticipantId,
  exchangeId: ExchangeId,
  message: Schema.String.check(Schema.isNonEmpty()),
  clientRequestId: Schema.String.check(Schema.isNonEmpty()),
});
const decodeAnswerRequest = Schema.decodeUnknownEffect(AnswerRequest);

const authenticate = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (error: unknown) => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "A2AHumanInboxError";
  const message = error instanceof Error ? error.message : "Human inbox operation failed.";
  const status =
    tag === "A2AExchangeNotOpenError" || tag === "A2AExchangeAlreadyAnsweredError"
      ? 409
      : tag === "A2AParticipantNotFoundError"
        ? 404
        : tag === "A2AHumanPersonIdError" || tag === "SchemaError"
          ? 400
          : 500;
  return HttpServerResponse.jsonUnsafe({ error: tag, message }, { status });
};

const providedHumanInboxLayer = humanInboxLayer.pipe(Layer.provideMerge(ledgerLayer));
const providedManualDeliveryLayer = manualDeliveryWorkerLayer.pipe(
  Layer.provideMerge(deliveryTransportLayer),
  Layer.provideMerge(ledgerLayer),
);
const routeServices = Layer.mergeAll(providedHumanInboxLayer, providedManualDeliveryLayer);

/** Authenticated raw routes keep A4 out of upstream wire contracts. */
export const humanInboxHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const inbox = yield* A2AHumanInbox;
    const worker = yield* A2ADeliveryWorker;
    const listRoute = HttpRouter.add(
      "GET",
      INBOX_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.humanInbox.list");
        yield* authenticate(AuthOrchestrationReadScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return requestFailure("The request URL is invalid.");
        const personId = url.value.searchParams.get("personId");
        if (personId === null || personId.length === 0) {
          return requestFailure("personId=human:<person-id> is required.");
        }
        const result = yield* Effect.result(inbox.list(ParticipantId.make(personId)));
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe({ items: result.success })
          : operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    const answerRoute = HttpRouter.add(
      "POST",
      ANSWER_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.humanInbox.answer");
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeAnswerRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "A valid personId, exchangeId, message, and clientRequestId are required.",
          );
        }
        const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const result = yield* Effect.result(
          inbox
            .answer({
              commandId: CommCommandId.make(
                `command:j5:a2a:human:${encodeURIComponent(decoded.success.clientRequestId)}`,
              ),
              personId: decoded.success.personId,
              exchangeId: decoded.success.exchangeId,
              message: decoded.success.message,
              acceptedAt,
            })
            .pipe(Effect.tap(() => worker.drain)),
        );
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe({ result: result.success })
          : operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return Layer.mergeAll(listRoute, answerRoute);
  }),
).pipe(Layer.provide(routeServices));
