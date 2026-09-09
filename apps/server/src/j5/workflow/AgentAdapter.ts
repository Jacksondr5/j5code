import {
  BuiltInAgentPersonaId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { getBuiltInAgentPersona } from "../agents/agentPersonas.ts";
import {
  resolveBuiltInAgentPersonaRoute,
  unavailableAgentPersonaReason,
} from "../agents/agentPersonaRouting.ts";
import { translateAgentPersonaProviderPolicy } from "../agents/agentPersonaProviderPolicy.ts";
import { WorkflowError } from "./Store.ts";
import { hash } from "./Definition.ts";
import type { Adapter } from "./Worker.ts";

export const AgentInput = Schema.Struct({
  personaId: BuiltInAgentPersonaId,
  prompt: Schema.String,
  worktree: Schema.String,
  branch: Schema.String,
  selectedEvidenceIds: Schema.Array(Schema.String),
  selectedEvidenceHashes: Schema.Array(Schema.String),
});
const isAgentInput = Schema.is(AgentInput);
const decodeInput = Schema.decodeUnknownEffect(AgentInput);
const decodeCorrection = Schema.decodeUnknownEffect(
  Schema.Struct({ original: Schema.Unknown, correction: Schema.String, output: Schema.Unknown }),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const failure = (error: unknown) => new WorkflowError({ code: "invalid", detail: String(error) });
const threadIdFor = (id: string) => ThreadId.make(`thread:wf:${hash(id)}`);
export const findActionRun = <T extends { readonly userMessageId: string }>(
  runs: readonly T[],
  actionId: string,
) => runs.find((run) => run.userMessageId === `${actionId}:message`);

export const makeAgentAdapter = Effect.gen(function* () {
  const launch = yield* ThreadLaunchService;
  const threads = yield* ThreadManagementService;
  const registry = yield* ProviderRegistry;
  const receipts = yield* CommandReceiptStoreV2;
  return {
    recovery: "reconcile",
    reconcile: (action, run, recordIdentity) =>
      Effect.gen(function* () {
        let rawInput = action.input;
        const corrections: string[] = [];
        while (!isAgentInput(rawInput)) {
          const correction = yield* decodeCorrection(rawInput);
          corrections.push(correction.correction);
          rawInput = correction.original;
        }
        const input = yield* decodeInput(rawInput);
        const threadId = threadIdFor(action.id);
        const messageId = MessageId.make(`${action.id}:message`);
        const receipt = yield* receipts.getByCommandId(CommandId.make(action.id));
        let projection = Option.isSome(receipt)
          ? yield* threads.getThreadProjection(threadId)
          : null;
        if (!projection?.runs.some((item) => item.userMessageId === messageId)) {
          const assignment = projection?.thread.agentPersonaAssignment;
          const authorityPolicy =
            assignment?.authorityPolicy ??
            getBuiltInAgentPersona(input.personaId).authority.defaultPolicy;
          const resolution = assignment
            ? {
                status: "available" as const,
                modelSelection: assignment.resolvedModelSelection,
                driver: assignment.resolvedDriver,
              }
            : resolveBuiltInAgentPersonaRoute({
                personaId: input.personaId,
                providers: yield* registry.getProviders,
                authorityPolicy,
              });
          if (resolution.status !== "available")
            return {
              status: "blocked",
              cause: unavailableAgentPersonaReason(resolution),
              recovery: "retry",
            } as const;
          // A recorded launch is reconciled using its durable assignment, never a newly chosen route.
          yield* launch.launch({
            commandId: CommandId.make(action.id),
            threadId,
            squadronId: run.squadronId,
            projectId: ProjectId.make(run.projectId),
            title: `${input.personaId}: ${run.id}`,
            modelSelection: resolution.modelSelection,
            runtimeMode: translateAgentPersonaProviderPolicy(authorityPolicy, resolution.driver)
              .runtimeMode,
            interactionMode: "default",
            workspaceStrategy: {
              type: "existing_worktree",
              worktreePath: input.worktree,
              branch: input.branch,
            },
            agentPersona: { personaId: input.personaId, authorityPolicy },
            initialMessage: {
              messageId,
              attachments: [],
              text: `${input.prompt}\n${corrections.map((item) => `Output correction required: ${item}`).join("\n")}`,
            },
            createdBy: "user",
            creationSource: "web",
          });
          projection = yield* threads.getThreadProjection(threadId);
        }
        if (projection === null) projection = yield* threads.getThreadProjection(threadId);
        const exactRun = findActionRun(projection.runs, action.id);
        if (!exactRun)
          return {
            status: "blocked",
            cause: "Launch has no durable initial run",
            recovery: "inspect_external_result",
          } as const;
        yield* recordIdentity(`${threadId}/${exactRun.id}`);
        if (["failed", "cancelled", "interrupted", "rolled_back"].includes(exactRun.status)) {
          return {
            status: "blocked",
            cause: `Provider run ${exactRun.id}: ${exactRun.status}`,
            recovery: null,
          } as const;
        }
        if (exactRun.status !== "completed") return { status: "pending" } as const;
        const text = projection.messages
          .filter((item) => item.runId === exactRun.id && item.role === "assistant")
          .map((item) => item.text)
          .join("\n");
        // Invalid JSON is sent to the decider as invalid output, consuming its correction budget.
        const output = yield* decodeJson(text).pipe(Effect.orElseSucceed(() => text));
        return { status: "completed", output } as const;
      }).pipe(Effect.mapError(failure)),
    interrupt: (action) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* receipts.getByCommandId(CommandId.make(action.id)))) return;
        const threadId = threadIdFor(action.id);
        const projection = yield* threads.getThreadProjection(threadId);
        const exactRun = projection.runs.find(
          (item) => item.userMessageId === `${action.id}:message`,
        );
        if (
          !exactRun ||
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
            exactRun.status,
          )
        )
          return;
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${action.id}:interrupt`),
          threadId,
          runId: exactRun.id,
        });
        const updated = yield* threads.getThreadProjection(threadId);
        const interrupted = updated.runs.find((item) => item.id === exactRun.id);
        if (
          interrupted &&
          !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
            interrupted.status,
          )
        )
          return yield* new WorkflowError({
            code: "conflict",
            detail: `Provider run ${exactRun.id} did not confirm interruption`,
          });
      }).pipe(Effect.mapError(failure)),
  } satisfies Adapter;
});
