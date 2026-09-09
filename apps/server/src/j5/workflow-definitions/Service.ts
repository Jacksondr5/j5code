import { StartRequest, type Run, type RunDetail } from "@j5/workflow-contracts";
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
import { isWorkflowThread } from "@j5/workflow-contracts/sidebar";

const decodeValidationEffect = Schema.decodeUnknownEffect(Handoff.Validation);
const decodeWorkspaceEffect = Schema.decodeUnknownEffect(Handoff.Workspace);

const isWorkflowError = Schema.is(WorkflowError);
const failure = (error: unknown) =>
  isWorkflowError(error) ? error : new WorkflowError({ code: "storage", detail: String(error) });
const COMPATIBLE_PLAN_REVIEW_HASH =
  "0d60b857145724fc735651db6ff50104eb5b81ac75033125d9102ab75e250eb1";
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
  const candidateIsCurrent = Effect.fn("WorkflowService.candidateIsCurrent")(function* (run: Run) {
    const workspace = yield* decodeWorkspaceEffect(latest(run, "workspace").content).pipe(
      Effect.mapError(failure),
    );
    const validation = yield* decodeValidationEffect(latest(run, "validation").content).pipe(
      Effect.mapError(failure),
    );
    const current = yield* Effect.tryPromise({
      try: () => candidate(workspace.worktree, run.baseCommit),
      catch: failure,
    });
    return current.codeIdentity === validation.codeIdentity;
  });
  const worker = makeWorker(
    store,
    definitions,
    adapters,
    `server:${yield* Clock.currentTimeMillis}`,
    candidateIsCurrent,
  );
  const wake = yield* Queue.dropping<void>(1);
  const candidateWake = yield* Queue.dropping<void>(1);
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const restartAvailability = (
    run: Pick<
      RunDetail,
      | "definitionId"
      | "definitionVersion"
      | "definitionHash"
      | "phase"
      | "status"
      | "failureCategory"
      | "visits"
    >,
  ) => {
    const definition = definitions.find(
      (item) => item.id === run.definitionId && item.version === run.definitionVersion,
    );
    const phase = definition?.phases.find((item) => item.id === run.phase);
    const compatibleDefinitionUpgrade =
      run.definitionId === "fh-development" &&
      run.definitionVersion === 2 &&
      run.definitionHash === COMPATIBLE_PLAN_REVIEW_HASH &&
      run.phase === "plan_review";
    const targetDefinitionHash = definition?.hash ?? run.definitionHash;
    if (!["plan_review", "code_review"].includes(run.phase))
      return {
        available: false,
        reason: "Only plan and code review timeouts can be restarted.",
        targetDefinitionHash,
        nextVisit: null,
        maxVisits: phase?.maxVisits ?? null,
        compatibleDefinitionUpgrade,
      };
    const nextVisit = (run.visits[run.phase] ?? 0) + 1;
    if (run.status !== "blocked" || run.failureCategory !== "action_deadline_expired")
      return {
        available: false,
        reason: "This review did not stop because its deadline elapsed.",
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase?.maxVisits ?? null,
        compatibleDefinitionUpgrade,
      };
    if (
      !definition ||
      !phase ||
      (definition.hash !== run.definitionHash && !compatibleDefinitionUpgrade)
    )
      return {
        available: false,
        reason: "The pinned workflow definition is not compatible with restart recovery.",
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase?.maxVisits ?? null,
        compatibleDefinitionUpgrade,
      };
    if (nextVisit > phase.maxVisits)
      return {
        available: false,
        reason: `All ${phase.maxVisits} review attempts have been used.`,
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase.maxVisits,
        compatibleDefinitionUpgrade,
      };
    return {
      available: true,
      reason: compatibleDefinitionUpgrade
        ? "Restart is available after a compatible workflow engine update."
        : "Restart is available.",
      targetDefinitionHash,
      nextVisit,
      maxVisits: phase.maxVisits,
      compatibleDefinitionUpgrade,
    };
  };
  const present = Effect.fn("WorkflowService.present")(function* (run: Run) {
    const detail = yield* store.present(run);
    return { ...detail, restartAvailability: restartAvailability(detail) };
  });
  const detail = Effect.fn("WorkflowService.detail")(function* (id: string) {
    const run = yield* store.detail(id);
    return { ...run, restartAvailability: restartAvailability(run) };
  });
  const start = Effect.fn("WorkflowService.start")(function* (input: typeof StartRequest.Type) {
    if (input.expectedRevision !== 0)
      return yield* new WorkflowError({
        code: "conflict",
        detail: "New runs require revision zero",
      });
    const definition = definitions.find((item) => item.id === input.definitionId);
    if (!definition)
      return yield* new WorkflowError({ code: "invalid", detail: "Unknown definition" });
    const baseRef = input.baseRef.trim();
    if (!baseRef)
      return yield* new WorkflowError({
        code: "invalid",
        detail: "Enter a base ref before starting the workflow",
      });
    const id = `workflow:${hash(input.commandId)}`;
    const inputs = { request: input.request, baseRef, evidence: input.evidence };
    const receiptInput = {
      type: "start",
      runId: id,
      definitionId: input.definitionId,
      squadronId: input.squadronId,
      inputs,
    };
    const replay = yield* store.receipt(input.commandId, receiptInput);
    if (replay) return yield* present(replay);
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
      try: () => resolveBase(project.value.workspaceRoot, baseRef),
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
        receiptInput,
        now: yield* Clock.currentTimeMillis,
      },
      definition,
    );
    yield* notify;
    return yield* present(run);
  }, Effect.mapError(failure));
  const mutate = Effect.fn("WorkflowService.mutate")(function* (
    id: string,
    commandId: string,
    expectedRevision: number,
    event: Extract<
      Event,
      {
        type: "decision" | "cancel" | "retry" | "edit_gate" | "restart_phase" | "retry_restart";
      }
    >,
  ) {
    const run = yield* store.get(id);
    const definition = definitions.find(
      (item) => item.id === run.definitionId && item.version === run.definitionVersion,
    );
    let commandEvent = event;
    if (event.type === "restart_phase") {
      if (run.recovery === "retry_restart" && run.restart) {
        if (event.targetDefinitionHash !== run.restart.targetDefinitionHash)
          return yield* new WorkflowError({
            code: "conflict",
            detail: "Displayed workflow definition has changed",
          });
        commandEvent = { type: "retry_restart" };
      } else {
        const availability = restartAvailability(run);
        if (!availability.available)
          return yield* new WorkflowError({ code: "conflict", detail: availability.reason });
        if (event.targetDefinitionHash !== availability.targetDefinitionHash)
          return yield* new WorkflowError({
            code: "conflict",
            detail: "Displayed workflow definition has changed",
          });
        if (!definition)
          return yield* new WorkflowError({
            code: "conflict",
            detail: "Workflow definition is unavailable",
          });
        if (availability.compatibleDefinitionUpgrade) {
          if (run.approvals.some((approval) => approval.phase === "plan_approval"))
            return yield* new WorkflowError({
              code: "conflict",
              detail: "Compatibility upgrade is limited to runs blocked before plan approval",
            });
          yield* Effect.try({
            try: () => {
              for (const action of run.actions.filter(
                (item) => item.status === "completed" && item.resultArtifactId,
              )) {
                const artifact = run.artifacts.find((item) => item.id === action.resultArtifactId);
                if (!artifact) throw new Error(`Missing retained artifact for ${action.id}`);
                definition.validate(action, artifact.content, run);
              }
            },
            catch: (error) =>
              new WorkflowError({
                code: "invalid",
                detail: `Retained workflow evidence is incompatible: ${String(error)}`,
              }),
          });
        }
        if (run.phase === "code_review" && !(yield* candidateIsCurrent(run))) {
          yield* store.command(
            {
              commandId: `changed:${run.id}:${run.revision}`,
              runId: run.id,
              expectedRevision: run.revision,
              event: { type: "invalidate", cause: "Candidate code changed" },
              now: yield* Clock.currentTimeMillis,
            },
            definition,
          );
          return yield* new WorkflowError({ code: "conflict", detail: "Candidate code changed" });
        }
        commandEvent = {
          ...event,
          compatibleDefinitionUpgrade: availability.compatibleDefinitionUpgrade,
        };
      }
    }
    if (
      run.phase === "publication_approval" &&
      (event.type === "decision" || event.type === "edit_gate") &&
      !(yield* candidateIsCurrent(run))
    ) {
      const invalidated = yield* store.command(
        {
          commandId: `changed:${run.id}:${run.revision}`,
          runId: run.id,
          expectedRevision: run.revision,
          event: { type: "invalidate", cause: "Candidate code changed" },
          now: yield* Clock.currentTimeMillis,
        },
        definition,
      );
      for (const action of run.actions.filter((item) => item.status === "pending")) {
        yield* adapters[action.adapter]?.interrupt(action, invalidated) ?? Effect.void;
      }
      return yield* new WorkflowError({ code: "conflict", detail: "Candidate code changed" });
    }
    const next = yield* store.command(
      {
        commandId,
        runId: id,
        expectedRevision,
        event:
          commandEvent.type === "retry" && run.recovery === "restore_definition"
            ? { type: "recover" }
            : commandEvent,
        now: yield* Clock.currentTimeMillis,
      },
      definition,
    );
    if (next.status === "cancelling") {
      for (const action of next.actions.filter((item) => item.status === "cancelled")) {
        yield* (
          adapters[action.adapter]
            ?.interrupt(action, next)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Workflow action did not confirm interruption during cancellation",
                  { workflowId: next.id, actionId: action.id, error },
                ),
              ),
            ) ?? Effect.void
        );
      }
    }
    yield* notify;
    return yield* present(next);
  }, Effect.mapError(failure));
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (
        !isWorkflowThread(event.threadId) ||
        ![
          "run.created",
          "run.updated",
          "thread.archived",
          "thread.deleted",
          "thread.unarchived",
        ].includes(event.type)
      ) {
        return Effect.void;
      }
      const completion =
        event.type === "run.updated" &&
        ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
          event.payload.status,
        );
      return completion
        ? Effect.all([notify, Queue.offer(candidateWake, undefined)], { discard: true })
        : notify;
    }),
    Effect.forkScoped,
  );
  const candidateCheckedAt = new Map<string, number>();
  const recheckCandidates = Effect.fn("WorkflowService.recheckCandidates")(function* () {
    let cursor = 0;
    while (true) {
      const records = yield* store.watchedBatch(cursor, 100);
      if (records.length === 0) return;
      for (const record of records) {
        const now = yield* Clock.currentTimeMillis;
        const checkedAt = candidateCheckedAt.get(record.id);
        if (checkedAt !== undefined && now - checkedAt < 30_000) continue;
        candidateCheckedAt.set(record.id, now);
        const run = yield* store.get(record.id);
        const definition = definitions.find(
          (item) => item.id === run.definitionId && item.version === run.definitionVersion,
        );
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
        if (!["code_review", "publication_approval"].includes(record.phase)) continue;
        if (!(yield* candidateIsCurrent(run))) {
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
      cursor = records.at(-1)!.creationSequence;
    }
  });
  yield* Effect.gen(function* () {
    while (true) {
      yield* worker
        .drain()
        .pipe(
          Effect.catch((error) => Effect.logError("Workflow worker stopped this pass", { error })),
        );
      yield* Queue.take(wake).pipe(Effect.raceFirst(Effect.sleep("1 second")));
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }), Effect.forkScoped);
  yield* Effect.gen(function* () {
    while (true) {
      yield* recheckCandidates().pipe(
        Effect.catch((error) => Effect.logError("Workflow candidate check failed", { error })),
      );
      yield* Queue.take(candidateWake).pipe(
        Effect.andThen(Effect.sleep("250 millis")),
        Effect.raceFirst(Effect.sleep("30 seconds")),
      );
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
    get: (id: string) => detail(id).pipe(Effect.mapError(failure)),
    readVersion: (id: string) => store.readVersion(id).pipe(Effect.mapError(failure)),
    artifact: (runId: string, artifactId: string) =>
      store.artifact(runId, artifactId).pipe(Effect.mapError(failure)),
  };
});
export class WorkflowService extends Context.Service<
  WorkflowService,
  Effect.Success<typeof makeService>
>()("t3/j5/workflow-definitions/Service/WorkflowService") {}
export const workflowLayer = Layer.effect(WorkflowService, makeService).pipe(
  Layer.provide(receiptLayer),
);
