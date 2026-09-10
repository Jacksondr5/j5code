import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  readWorkflowApprovalCount,
  readWorkflowEntries,
  readWorkflowThreadParent,
} from "./SidebarRead.ts";
import {
  GateRequest,
  MetadataRequest,
  Mutation,
  RestartPhaseRequest,
  RunStatus,
  StartRequest,
} from "@j5/workflow-contracts";
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { WorkflowService } from "../workflow-definitions/Service.ts";

const decodeGateRequestEffect = Schema.decodeUnknownEffect(GateRequest);
const decodeMetadataRequestEffect = Schema.decodeUnknownEffect(MetadataRequest);
const decodeMutationEffect = Schema.decodeUnknownEffect(Mutation);
const decodeRestartPhaseRequestEffect = Schema.decodeUnknownEffect(RestartPhaseRequest);
const decodeStartRequestEffect = Schema.decodeUnknownEffect(StartRequest);
const isRunStatus = Schema.is(RunStatus);

const authenticate = (operate: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    const scope = operate ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
    if (!session.scopes.includes(scope)) return yield* failEnvironmentScopeRequired(scope);
    return session;
  });

export const workflowHttpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* WorkflowService;
    const sql = yield* SqlClient.SqlClient;
    const handler = (operate: boolean) =>
      Effect.gen(function* () {
        const session = yield* authenticate(operate);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://workflow.local");
        const parts = url.pathname.split("/").filter(Boolean);
        const id = parts[3] ? decodeURIComponent(parts[3]) : undefined;
        if (!operate) {
          if (id === "sidebar") {
            const offset = Number(url.searchParams.get("offset") ?? 0);
            const status = url.searchParams.get("status") ?? "";
            if (!Number.isSafeInteger(offset) || offset < 0)
              return HttpServerResponse.jsonUnsafe({ message: "Invalid offset" }, { status: 400 });
            if (status !== "" && !isRunStatus(status))
              return HttpServerResponse.jsonUnsafe({ message: "Invalid status" }, { status: 400 });
            return HttpServerResponse.jsonUnsafe(
              yield* readWorkflowEntries(
                url.searchParams.get("squadronId") ?? "",
                (url.searchParams.get("q") ?? "").slice(0, 240),
                offset,
                Number(url.searchParams.get("limit") ?? 50),
                status,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            );
          }
          if (id === "approval-count")
            return HttpServerResponse.jsonUnsafe({
              count: yield* readWorkflowApprovalCount().pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            });
          if (id === "thread-parent")
            return HttpServerResponse.jsonUnsafe({
              parent: yield* readWorkflowThreadParent(url.searchParams.get("threadId") ?? "").pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            });
          if (id === "definitions")
            return HttpServerResponse.jsonUnsafe({ definitions: service.definitions });
          if (id && parts[4] === "artifacts" && parts[5])
            return HttpServerResponse.jsonUnsafe({
              artifact: yield* service.artifact(id, decodeURIComponent(parts[5])),
            });
          if (id) {
            const knownVersion = url.searchParams.get("ifReadVersion");
            if (knownVersion !== null) {
              const parsed = Number(knownVersion);
              if (!Number.isSafeInteger(parsed) || parsed < 0)
                return HttpServerResponse.jsonUnsafe(
                  { message: "Invalid read version" },
                  { status: 400 },
                );
              if ((yield* service.readVersion(id)) === parsed)
                return HttpServerResponse.empty({ status: 304 });
            }
            return HttpServerResponse.jsonUnsafe({ run: yield* service.get(id) });
          }
          return HttpServerResponse.jsonUnsafe(
            { message: "Unknown workflow read" },
            { status: 404 },
          );
        }
        const body = yield* request.json;
        if (!id)
          return HttpServerResponse.jsonUnsafe({
            run: yield* service.start(yield* decodeStartRequestEffect(body)),
          });
        const action = parts[4];
        if (action === "metadata") {
          const input = yield* decodeMetadataRequestEffect(body);
          return HttpServerResponse.jsonUnsafe({
            run: yield* service.mutate(id, input.commandId, input.expectedRevision, {
              type: "edit_gate",
              gateRevision: input.gateRevision,
              artifactHash: input.artifactHash,
              actor: session.subject,
              content: { commitMessage: input.commitMessage, title: input.title, body: input.body },
            }),
          });
        }
        if (action === "decide") {
          const input = yield* decodeGateRequestEffect(body);
          return HttpServerResponse.jsonUnsafe({
            run: yield* service.mutate(id, input.commandId, input.expectedRevision, {
              type: "decision",
              decision: {
                gateRevision: input.gateRevision,
                artifactHash: input.artifactHash,
                decision: input.decision,
                feedback: input.feedback,
                actor: session.subject,
              },
            }),
          });
        }
        if (action === "restart-phase") {
          const input = yield* decodeRestartPhaseRequestEffect(body);
          return HttpServerResponse.jsonUnsafe({
            run: yield* service.mutate(id, input.commandId, input.expectedRevision, {
              type: "restart_phase",
              targetDefinitionHash: input.definitionHash,
              actor: session.subject,
              compatibleDefinitionUpgrade: false,
            }),
          });
        }
        const input = yield* decodeMutationEffect(body);
        if (action !== "cancel" && action !== "retry")
          return HttpServerResponse.jsonUnsafe({ message: "Unknown action" }, { status: 404 });
        return HttpServerResponse.jsonUnsafe({
          run: yield* service.mutate(id, input.commandId, input.expectedRevision, { type: action }),
        });
      }).pipe(
        Effect.catchTags({
          SqlError: (error) => failEnvironmentInternal("internal_error", error),
          WorkflowError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { message: error.detail, error: { code: error.code, detail: error.detail } },
                {
                  status: error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 400,
                },
              ),
            ),
          SchemaError: () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { message: "Invalid workflow request" },
                { status: 400 },
              ),
            ),
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      );
    return Layer.mergeAll(
      HttpRouter.add("GET", "/api/j5/workflows", handler(false)),
      HttpRouter.add("GET", "/api/j5/workflows/:id", handler(false)),
      HttpRouter.add("GET", "/api/j5/workflows/:id/artifacts/:artifactId", handler(false)),
      HttpRouter.add("POST", "/api/j5/workflows", handler(true)),
      HttpRouter.add("POST", "/api/j5/workflows/:id/:action", handler(true)),
    );
  }),
);
