// @effect-diagnostics nodeBuiltinImport:off - shipped YAML is copied beside the server bundle.
import {
  StartRequest,
  type Run,
  type RunDetail,
  type WorkflowDefinitionPresentation,
} from "@j5/workflow-contracts";
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
import { compileYamlWorkflow } from "./Yaml.ts";
import { createWorkflowLibrary } from "./Library.ts";

import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  prepareWorkflowExecution,
  hasWorkflowSnapshots,
  legacyWorkflowMessage,
  workflowAuthorities,
} from "../workflow/Execution.ts";

const decodeValidationEffect = Schema.decodeUnknownEffect(Handoff.Validation);
const decodeWorkspaceEffect = Schema.decodeUnknownEffect(Handoff.Workspace);

const isWorkflowError = Schema.is(WorkflowError);
const failure = (error: unknown) =>
  isWorkflowError(error) ? error : new WorkflowError({ code: "storage", detail: String(error) });
const COMPATIBLE_PLAN_REVIEW_HASH =
  "0d60b857145724fc735651db6ff50104eb5b81ac75033125d9102ab75e250eb1";
export const makeService = Effect.gen(function* () {
  const store = yield* makeStore;
  const library = yield* makeAgentPersonaLibrary;
  const registry = yield* ProviderRegistry;
  const config = yield* ServerConfig;
  const projects = yield* ProjectService;
  const references = yield* SquadronProjectReferences;
  const threads = yield* ThreadManagementService;
  const persona = yield* makeAgentAdapter;
  const implementations = { "fh-development-v3": development };
  const shippedDevelopment = compileYamlWorkflow(
    NodeFS.readFileSync(new URL("./fh/development.yaml", import.meta.url), "utf8"),
    "shipped:fh/development.yaml",
    implementations,
  );
  const researchReview = compileYamlWorkflow(
    NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8"),
    "shipped:research-review.yaml",
  );
  const workflowLibrary = createWorkflowLibrary(
    config.stateDir,
    [shippedDevelopment, researchReview],
    implementations,
  );
  const definitions = [
    ...workflowLibrary
      .catalog()
      .flatMap((entry) => (entry.enabled && entry.definition ? [entry.definition] : [])),
    ...workflowLibrary.savedDefinitions(),
  ];
  const refreshDefinitions = () => {
    for (const definition of workflowLibrary
      .catalog()
      .flatMap((entry) => (entry.enabled && entry.definition ? [entry.definition] : [])))
      if (!definitions.some((item) => item.hash === definition.hash)) definitions.push(definition);
  };
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
    const pinnedDefinition = definitions.find(
      (item) =>
        item.id === run.definitionId &&
        item.version === run.definitionVersion &&
        item.hash === run.definitionHash,
    );
    if (run.definitionId === "fh-development" && run.definitionVersion < 3)
      return {
        available: false,
        reason: legacyWorkflowMessage,
        targetDefinitionHash: run.definitionHash,
        nextVisit: null,
        maxVisits: null,
        compatibleDefinitionUpgrade: false,
      };
    const compatibleDefinitionUpgrade =
      run.definitionId === "fh-development" &&
      run.definitionVersion === 2 &&
      run.definitionHash === COMPATIBLE_PLAN_REVIEW_HASH &&
      run.phase === "plan_review";
    const definition =
      pinnedDefinition ??
      (compatibleDefinitionUpgrade
        ? definitions.find((item) => item.id === run.definitionId)
        : undefined);
    const phase = definition?.phases.find((item) => item.id === run.phase);
    const targetDefinitionHash = definition?.hash ?? run.definitionHash;
    if (!phase?.capabilities?.includes("restart"))
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
  const startPermit = yield* Semaphore.make(1);
  const start = Effect.fn("WorkflowService.start")(
    function* (input: typeof StartRequest.Type) {
      if (input.expectedRevision !== 0)
        return yield* new WorkflowError({
          code: "conflict",
          detail: "New runs require revision zero",
        });
      const definition = workflowLibrary
        .catalog()
        .find((item) => item.id === input.definitionId && item.enabled)?.definition;
      if (!definition)
        return yield* new WorkflowError({ code: "invalid", detail: "Unknown definition" });
      if (
        (input.definitionVersion !== undefined && input.definitionVersion !== definition.version) ||
        (input.definitionHash !== undefined && input.definitionHash !== definition.hash)
      )
        return yield* new WorkflowError({
          code: "conflict",
          detail: "Displayed workflow definition has changed",
        });
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
      const execution = yield* prepareWorkflowExecution(
        `${config.stateDir}/workflows`,
        library,
        yield* registry.getProviders,
        definition.agents ??
          Object.fromEntries(
            Object.entries(workflowAuthorities).map(([persona, authority]) => [
              persona,
              { persona, authority },
            ]),
          ),
        definition.source
          ? { source: definition.source, runtime: definition.runtime ?? "unsupported" }
          : undefined,
      );
      yield* Effect.try({
        try: () => workflowLibrary.snapshot(definition),
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
        execution,
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
    },
    startPermit.withPermit,
    Effect.mapError(failure),
  );
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
    if (event.type !== "cancel" && !hasWorkflowSnapshots(run.execution))
      return yield* new WorkflowError({ code: "invalid", detail: legacyWorkflowMessage });
    let definition = definitions.find(
      (item) =>
        item.id === run.definitionId &&
        item.version === run.definitionVersion &&
        item.hash === run.definitionHash,
    );
    const phase = definition?.phases.find((item) => item.id === run.phase);
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
        if (availability.compatibleDefinitionUpgrade)
          definition = definitions.find((item) => item.id === run.definitionId);
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
                definition!.validate(action, artifact.content, run);
              }
            },
            catch: (error) =>
              new WorkflowError({
                code: "invalid",
                detail: `Retained workflow evidence is incompatible: ${String(error)}`,
              }),
          });
        }
        if (phase?.capabilities?.includes("candidate-watch") && !(yield* candidateIsCurrent(run))) {
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
      definition?.phases
        .find((phase) => phase.id === run.phase)
        ?.capabilities?.includes("publication") &&
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
          (item) =>
            item.id === run.definitionId &&
            item.version === run.definitionVersion &&
            item.hash === run.definitionHash,
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
        if (
          !definition?.phases
            .find((phase) => phase.id === record.phase)
            ?.capabilities?.includes("candidate-watch")
        )
          continue;
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
  // Presentation prerequisites must not prevent saved commands from replaying when the
  // mutable persona library is temporarily invalid. New starts still perform strict preflight.
  const personaCatalog = yield* library
    .catalog()
    .pipe(Effect.orElseSucceed(() => ({ definitions: [], disabledIds: [] })));
  const disabledPersonas = new Set(personaCatalog.disabledIds);
  const availablePersonas = new Set(
    personaCatalog.definitions
      .filter((persona) => !disabledPersonas.has(persona.id))
      .map((persona) => persona.id),
  );
  return {
    start,
    mutate,
    get definitions() {
      const current = workflowLibrary.catalog();
      const presentations: WorkflowDefinitionPresentation[] = current.map((entry) => {
        const definition = entry.definition;
        const requiredPersonas = Object.values(
          definition?.agents ??
            Object.fromEntries(
              Object.entries(workflowAuthorities).map(([persona, authority]) => [
                persona,
                { persona, authority },
              ]),
            ),
        ).map((assignment) => assignment.persona);
        const missingPersonas = [...new Set(requiredPersonas)].filter(
          (persona) => !availablePersonas.has(persona),
        );
        const diagnostics = [
          ...entry.diagnostics,
          ...(missingPersonas.length
            ? [`Missing or disabled agent personas: ${missingPersonas.join(", ")}`]
            : []),
        ];
        return {
          id: entry.id,
          version: definition?.version ?? 0,
          hash: definition?.hash ?? "",
          initial: definition?.initial ?? "",
          title: entry.title,
          description: entry.description,
          enabled: entry.enabled && diagnostics.length === 0,
          source: entry.source,
          diagnostics,
          capabilities: [...(definition?.capabilities ?? [])],
          phases: (definition?.phases ?? []).map(
            ({ id: phaseId, label, kind, capabilities, maxVisits, transitions }) => ({
              id: phaseId,
              ...(label ? { label } : {}),
              ...(capabilities ? { capabilities: [...capabilities] } : {}),
              kind,
              maxVisits,
              transitions,
            }),
          ),
        };
      });
      for (const definition of definitions) {
        if (presentations.some((item) => item.hash === definition.hash)) continue;
        presentations.push({
          id: definition.id,
          version: definition.version,
          hash: definition.hash,
          initial: definition.initial,
          ...(definition.title === undefined ? {} : { title: definition.title }),
          ...(definition.description === undefined ? {} : { description: definition.description }),
          enabled: false,
          diagnostics: [],
          capabilities: [...(definition.capabilities ?? [])],
          phases: definition.phases.map(
            ({ id, label, kind, capabilities, maxVisits, transitions }) => ({
              id,
              ...(label ? { label } : {}),
              ...(capabilities ? { capabilities: [...capabilities] } : {}),
              kind,
              maxVisits,
              transitions,
            }),
          ),
        });
      }
      return presentations;
    },
    importDefinitions: (files: readonly { name: string; content: string }[], confirm = false) =>
      Effect.try({
        try: () => {
          workflowLibrary.import(files, confirm);
          refreshDefinitions();
          return workflowLibrary.catalog();
        },
        catch: failure,
      }),
    setDefinitionEnabled: (id: string, enabled: boolean) =>
      Effect.try({
        try: () => {
          workflowLibrary.setEnabled(id, enabled);
          refreshDefinitions();
          return workflowLibrary.catalog();
        },
        catch: failure,
      }),
    removeDefinition: (id: string) =>
      Effect.try({
        try: () => {
          workflowLibrary.remove(id);
          refreshDefinitions();
          return workflowLibrary.catalog();
        },
        catch: failure,
      }),
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
