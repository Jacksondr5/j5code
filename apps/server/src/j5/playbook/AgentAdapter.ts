import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  readPlaybookExecution,
  playbookAuthorities,
  hasPlaybookSnapshots,
  legacyPlaybookMessage,
} from "./Execution.ts";
import { translateAgentPersonaProviderPolicy } from "../agents/agentPersonaProviderPolicy.ts";
import { PlaybookError } from "./Store.ts";
import { hash } from "./Definition.ts";
import type { Adapter } from "./Worker.ts";

export const AgentInput = Schema.Struct({
  personaId: Schema.String,
  assignmentKey: Schema.optional(Schema.String),
  authorityPolicy: Schema.optional(Schema.String),
  sharedInstance: Schema.optional(Schema.String),
  assignmentDigest: Schema.String,
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
const failure = (error: unknown) => new PlaybookError({ code: "invalid", detail: String(error) });
const threadIdFor = (runId: string, actionId: string, sharedInstance?: string) =>
  ThreadId.make(`thread:pb:${hash(sharedInstance ? [runId, sharedInstance] : actionId)}`);
export const findActionRun = <T extends { readonly userMessageId: string }>(
  runs: readonly T[],
  actionId: string,
) => runs.find((run) => run.userMessageId === `${actionId}:message`);

export const makeAgentAdapter = Effect.gen(function* () {
  const launch = yield* ThreadLaunchService;
  const threads = yield* ThreadManagementService;
  const receipts = yield* CommandReceiptStoreV2;
  return {
    recovery: "reconcile",
    reconcile: (action, run, recordIdentity) =>
      Effect.gen(function* () {
        if (!hasPlaybookSnapshots(run.execution))
          return { status: "blocked", cause: legacyPlaybookMessage, recovery: null } as const;
        let rawInput = action.input;
        const corrections: string[] = [];
        while (!isAgentInput(rawInput)) {
          const correction = yield* decodeCorrection(rawInput);
          corrections.push(correction.correction);
          rawInput = correction.original;
        }
        const input = yield* decodeInput(rawInput);
        const threadId = threadIdFor(run.id, action.id, input.sharedInstance);
        const messageId = MessageId.make(`${action.id}:message`);
        const receipt = yield* receipts.getByCommandId(CommandId.make(action.id));
        let projection =
          Option.isSome(receipt) || input.sharedInstance
            ? yield* threads.getThreadProjection(threadId).pipe(Effect.orElseSucceed(() => null))
            : null;
        if (!projection?.runs.some((item) => item.userMessageId === messageId)) {
          const assignment = readPlaybookExecution(run.execution).personas[
            input.assignmentKey ?? input.personaId
          ];
          const expectedAuthority =
            input.authorityPolicy ??
            playbookAuthorities[input.personaId as keyof typeof playbookAuthorities];
          if (
            !assignment ||
            assignment.definitionDigest !== input.assignmentDigest ||
            assignment.personaId !== input.personaId ||
            assignment.authorityPolicy !== expectedAuthority
          )
            return {
              status: "blocked",
              cause: "Playbook persona snapshot reference is invalid. Start a fresh task.",
              recovery: null,
            } as const;
          const authorityPolicy = assignment.authorityPolicy;
          const resolution = {
            modelSelection: assignment.resolvedModelSelection,
            driver: assignment.resolvedDriver,
          };
          // A recorded launch is reconciled using its durable assignment, never a newly chosen route.
          const text = `${input.prompt}\n${corrections.map((item) => `Output correction required: ${item}`).join("\n")}`;
          if (input.sharedInstance && projection !== null) {
            const foreign = projection.runs.find(
              (item) => !String(item.userMessageId).startsWith("pb:"),
            );
            if (foreign)
              return {
                status: "blocked",
                cause: `Shared agent ${input.sharedInstance} contains unexpected work`,
                recovery: null,
              } as const;
            const active = projection?.runs.find(
              (item) =>
                !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                  item.status,
                ),
            );
            if (active)
              return {
                status: "blocked",
                cause: `Shared agent ${input.sharedInstance} is busy with provider run ${active.id}`,
                recovery: "retry",
              } as const;
            yield* threads.sendToThread({
              projectId: ProjectId.make(run.projectId),
              commandId: CommandId.make(action.id),
              threadId,
              messageId,
              text,
              attachments: [],
              modelSelection: resolution.modelSelection,
              mode: "auto",
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* launch.launch({
              commandId: CommandId.make(action.id),
              threadId,
              squadronId: run.squadronId,
              projectId: ProjectId.make(run.projectId),
              title: `${input.sharedInstance ?? input.personaId}: ${run.id}`,
              modelSelection: resolution.modelSelection,
              runtimeMode: translateAgentPersonaProviderPolicy(authorityPolicy, resolution.driver)
                .runtimeMode,
              interactionMode: "default",
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: input.worktree,
                branch: input.branch,
              },
              preparedPersonaAssignment: assignment,
              initialMessage: { messageId, attachments: [], text },
              createdBy: "user",
              creationSource: "web",
            });
          }
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
        let rawInput = action.input;
        while (!isAgentInput(rawInput)) rawInput = (yield* decodeCorrection(rawInput)).original;
        const input = yield* decodeInput(rawInput);
        const threadId = threadIdFor(action.runId, action.id, input.sharedInstance);
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
          return yield* new PlaybookError({
            code: "conflict",
            detail: `Provider run ${exactRun.id} did not confirm interruption`,
          });
      }).pipe(Effect.mapError(failure)),
  } satisfies Adapter;
});
