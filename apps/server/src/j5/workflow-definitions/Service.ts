import { StartRequest, type Run } from "@j5/workflow-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as DateTime from "effect/DateTime";
import { layer as receiptLayer } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { SquadronProjectReferences } from "../a2a/SquadronProjectReferences.ts";
import { SquadronId } from "../a2a/contracts.ts";
import * as Handoff from "@j5/workflow-contracts/fh";
import { candidate } from "./fh/GitWorkspace.ts";
import { development, latest } from "./fh/development.ts";
import { makeCodeAdapters } from "./fh/CodeAdapters.ts";
import { resolveBase } from "./fh/GitWorkspace.ts";
import { makeAgentAdapter } from "../workflow/AgentAdapter.ts";
import { hash, validateDefinition } from "../workflow/Definition.ts";
import type { Event } from "../workflow/decider.ts";
import { makeStore, WorkflowError } from "../workflow/Store.ts";
import { makeWorker, type Adapter } from "../workflow/Worker.ts";

const decodeValidationEffect = Schema.decodeUnknownEffect(Handoff.Validation);
const decodeWorkspaceEffect = Schema.decodeUnknownEffect(Handoff.Workspace);

const isWorkflowError = Schema.is(WorkflowError);
const failure = (error: unknown) =>
  isWorkflowError(error) ? error : new WorkflowError({ code: "storage", detail: String(error) });
export const makeService = Effect.gen(function* () {
  const store = yield* makeStore;
  const config = yield* ServerConfig;
  const projects = yield* ProjectService;
  const references = yield* SquadronProjectReferences;
  const threads = yield* ThreadManagementService;
  const persona = yield* makeAgentAdapter;
  const definitions = [development];
  for (const definition of definitions) validateDefinition(definition);
  const adapters: Record<string, Adapter> = {
    ...makeCodeAdapters(`${config.stateDir}/workflows`),
    persona,
  };
  const worker = makeWorker(
    store,
    definitions,
    adapters,
    `server:${yield* Clock.currentTimeMillis}`,
  );
  const wake = yield* Queue.unbounded<void>();
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const start = Effect.fn("WorkflowService.start")(function* (input: typeof StartRequest.Type) {
    if (input.expectedRevision !== 0)
      return yield* new WorkflowError({
        code: "conflict",
        detail: "New runs require revision zero",
      });
    const definition = definitions.find((item) => item.id === input.definitionId);
    if (!definition)
      return yield* new WorkflowError({ code: "invalid", detail: "Unknown definition" });
    const id = `workflow:${hash(input.commandId)}`;
    const inputs = { request: input.request, baseRef: input.baseRef, evidence: input.evidence };
    const existing = yield* store
      .get(id)
      .pipe(
        Effect.catchTag("WorkflowError", (error) =>
          error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    if (existing) {
      if (
        hash(existing.inputs) !== hash(inputs) ||
        existing.squadronId !== input.squadronId ||
        existing.definitionId !== input.definitionId
      ) {
        return yield* new WorkflowError({
          code: "conflict",
          detail: "Start id was reused with different input",
        });
      }
      return existing;
    }
    const refs = yield* references.listForSquadron(SquadronId.make(input.squadronId));
    if (refs.length !== 1)
      return yield* new WorkflowError({
        code: "invalid",
        detail: "Select a Squadron with exactly one project",
      });
    const project = yield* projects.getById(refs[0]!.projectId);
    if (Option.isNone(project))
      return yield* new WorkflowError({
        code: "not_found",
        detail: "Squadron project is unavailable",
      });
    const baseCommit = yield* Effect.tryPromise({
      try: () => resolveBase(project.value.workspaceRoot, input.baseRef),
      catch: failure,
    });
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const initial: Run = {
      id,
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      squadronId: input.squadronId,
      projectId: project.value.id,
      repository: project.value.workspaceRoot,
      baseCommit,
      inputs,
      execution: { stateRoot: `${config.stateDir}/workflows` },
      phase: definition.initial,
      revision: 0,
      status: "running",
      cause: null,
      failureCategory: null,
      relevantActionId: null,
      recovery: null,
      gate: null,
      actions: [],
      artifacts: [],
      approvals: [],
      visits: {},
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const run = yield* store.command(
      {
        commandId: input.commandId,
        runId: id,
        expectedRevision: 0,
        initial,
        event: { type: "enter" },
        now: yield* Clock.currentTimeMillis,
      },
      definition,
    );
    yield* notify;
    return run;
  }, Effect.mapError(failure));
  const mutate = Effect.fn("WorkflowService.mutate")(function* (
    id: string,
    commandId: string,
    expectedRevision: number,
    event: Extract<Event, { type: "decision" | "cancel" | "retry" | "edit_gate" }>,
  ) {
    const run = yield* store.get(id);
    const definition = definitions.find(
      (item) => item.id === run.definitionId && item.version === run.definitionVersion,
    );
    const next = yield* store.command(
      {
        commandId,
        runId: id,
        expectedRevision,
        event:
          event.type === "retry" && run.recovery === "restore_definition"
            ? { type: "recover" }
            : event,
        now: yield* Clock.currentTimeMillis,
      },
      definition,
    );
    if (next.status === "cancelling") {
      for (const action of next.actions.filter((item) => item.status === "cancelled")) {
        yield* adapters[action.adapter]?.interrupt(action, next) ?? Effect.void;
      }
    }
    yield* notify;
    return next;
  }, Effect.mapError(failure));
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach(() => notify),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    while (true) {
      for (const run of yield* store.watched()) {
        const definition = definitions.find(
          (item) => item.id === run.definitionId && item.version === run.definitionVersion,
        );
        const now = yield* Clock.currentTimeMillis;
        if (!definition || definition.hash !== run.definitionHash) {
          yield* store.command(
            {
              commandId: `definition:${run.id}:${run.revision}`,
              runId: run.id,
              expectedRevision: run.revision,
              event: { type: "recover" },
              now,
            },
            definition,
          );
          continue;
        }
        if (["code_review", "publication_approval"].includes(run.phase)) {
          const workspace = yield* decodeWorkspaceEffect(latest(run, "workspace").content);
          const validation = yield* decodeValidationEffect(latest(run, "validation").content);
          const current = yield* Effect.tryPromise({
            try: () => candidate(workspace.worktree, run.baseCommit),
            catch: failure,
          });
          if (current.codeIdentity !== validation.codeIdentity) {
            const next = yield* store.command(
              {
                commandId: `changed:${run.id}:${run.revision}`,
                runId: run.id,
                expectedRevision: run.revision,
                event: { type: "invalidate", cause: "Candidate code changed" },
                now,
              },
              definition,
            );
            for (const action of run.actions.filter((item) => item.status === "pending")) {
              yield* adapters[action.adapter]?.interrupt(action, next) ?? Effect.void;
            }
          }
        }
      }
      yield* worker
        .drain(yield* Clock.currentTimeMillis)
        .pipe(
          Effect.catch((error) => Effect.logError("Workflow worker stopped this pass", { error })),
        );
      yield* Queue.take(wake).pipe(Effect.raceFirst(Effect.sleep("1 second")));
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }), Effect.forkScoped);
  return {
    start,
    mutate,
    definitions: definitions.map(({ id, version, hash, initial, phases }) => ({
      id,
      version,
      hash,
      initial,
      phases: phases.map(({ id: phaseId, kind, maxVisits, transitions }) => ({
        id: phaseId,
        kind,
        maxVisits,
        transitions,
      })),
    })),
    get: (id: string) => store.get(id).pipe(Effect.mapError(failure)),
    list: (squadronId: string) => store.list(squadronId).pipe(Effect.mapError(failure)),
  };
});
export class WorkflowService extends Context.Service<
  WorkflowService,
  Effect.Success<typeof makeService>
>()("t3/j5/workflow-definitions/Service/WorkflowService") {}
export const workflowLayer = Layer.effect(WorkflowService, makeService).pipe(
  Layer.provide(receiptLayer),
);
