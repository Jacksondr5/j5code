// @effect-diagnostics nodeBuiltinImport:off - shipped YAML is copied beside the server bundle.
import {
  StartRequest,
  type Run,
  type RunDetail,
  type PlaybookDefinitionPresentation,
} from "@j5/playbook-contracts";
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
import * as Handoff from "@j5/playbook-contracts/fh";
import { candidate } from "./fh/GitWorkspace.ts";
import { development, latest } from "./fh/development.ts";
import { makeCodeAdapters } from "./fh/CodeAdapters.ts";
import { resolveBase } from "./fh/GitWorkspace.ts";
import { makeAgentAdapter } from "../playbook/AgentAdapter.ts";
import { hash, validateDefinition } from "../playbook/Definition.ts";
import type { Event } from "../playbook/decider.ts";
import { makeStore, PlaybookError } from "../playbook/Store.ts";
import { makeWorker, type Adapter } from "../playbook/Worker.ts";
import { isPlaybookThread } from "@j5/playbook-contracts/sidebar";
import { compileYamlPlaybook } from "./Yaml.ts";
import { createPlaybookLibrary } from "./Library.ts";

import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  preparePlaybookExecution,
  hasPlaybookSnapshots,
  legacyPlaybookMessage,
  playbookAuthorities,
} from "../playbook/Execution.ts";

const decodeValidationEffect = Schema.decodeUnknownEffect(Handoff.Validation);
const decodeWorkspaceEffect = Schema.decodeUnknownEffect(Handoff.Workspace);

const isPlaybookError = Schema.is(PlaybookError);
const failure = (error: unknown) =>
  isPlaybookError(error) ? error : new PlaybookError({ code: "storage", detail: String(error) });
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
  const shippedDevelopment = compileYamlPlaybook(
    NodeFS.readFileSync(new URL("./fh/development.yaml", import.meta.url), "utf8"),
    "shipped:fh/development.yaml",
    implementations,
  );
  const researchReview = compileYamlPlaybook(
    NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8"),
    "shipped:research-review.yaml",
  );
  const playbookLibrary = createPlaybookLibrary(
    config.stateDir,
    [shippedDevelopment, researchReview],
    implementations,
  );
  const definitions = [
    ...playbookLibrary
      .catalog()
      .flatMap((entry) => (entry.enabled && entry.definition ? [entry.definition] : [])),
    ...playbookLibrary.savedDefinitions(),
  ];
  const refreshDefinitions = () => {
    for (const definition of playbookLibrary
      .catalog()
      .flatMap((entry) => (entry.enabled && entry.definition ? [entry.definition] : [])))
      if (!definitions.some((item) => item.hash === definition.hash)) definitions.push(definition);
  };
  for (const definition of definitions) validateDefinition(definition);
  const adapters: Record<string, Adapter> = {
    ...makeCodeAdapters(`${config.stateDir}/playbook-runs`),
    persona,
  };
  const candidateIsCurrent = Effect.fn("PlaybookService.candidateIsCurrent")(function* (run: Run) {
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
    const definition = pinnedDefinition;
    const phase = definition?.phases.find((item) => item.id === run.phase);
    const targetDefinitionHash = definition?.hash ?? run.definitionHash;
    if (!phase?.capabilities?.includes("restart"))
      return {
        available: false,
        reason: "Only plan and code review timeouts can be restarted.",
        targetDefinitionHash,
        nextVisit: null,
        maxVisits: phase?.maxVisits ?? null,
      };
    const nextVisit = (run.visits[run.phase] ?? 0) + 1;
    if (run.status !== "blocked" || run.failureCategory !== "action_deadline_expired")
      return {
        available: false,
        reason: "This review did not stop because its deadline elapsed.",
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase?.maxVisits ?? null,
      };
    if (!definition || !phase)
      return {
        available: false,
        reason: "The pinned playbook definition is not compatible with restart recovery.",
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase?.maxVisits ?? null,
      };
    if (nextVisit > phase.maxVisits)
      return {
        available: false,
        reason: `All ${phase.maxVisits} review attempts have been used.`,
        targetDefinitionHash,
        nextVisit,
        maxVisits: phase.maxVisits,
      };
    return {
      available: true,
      reason: "Restart is available.",
      targetDefinitionHash,
      nextVisit,
      maxVisits: phase.maxVisits,
    };
  };
  const present = Effect.fn("PlaybookService.present")(function* (run: Run) {
    const detail = yield* store.present(run);
    return { ...detail, restartAvailability: restartAvailability(detail) };
  });
  const detail = Effect.fn("PlaybookService.detail")(function* (id: string) {
    const run = yield* store.detail(id);
    return { ...run, restartAvailability: restartAvailability(run) };
  });
  const startPermit = yield* Semaphore.make(1);
  const start = Effect.fn("PlaybookService.start")(
    function* (input: typeof StartRequest.Type) {
      if (input.expectedRevision !== 0)
        return yield* new PlaybookError({
          code: "conflict",
          detail: "New runs require revision zero",
        });
      const definition = playbookLibrary
        .catalog()
        .find((item) => item.id === input.definitionId && item.enabled)?.definition;
      if (!definition)
        return yield* new PlaybookError({ code: "invalid", detail: "Unknown definition" });
      if (
        (input.definitionVersion !== undefined && input.definitionVersion !== definition.version) ||
        (input.definitionHash !== undefined && input.definitionHash !== definition.hash)
      )
        return yield* new PlaybookError({
          code: "conflict",
          detail: "Displayed playbook definition has changed",
        });
      const baseRef = input.baseRef.trim();
      if (!baseRef)
        return yield* new PlaybookError({
          code: "invalid",
          detail: "Enter a base ref before starting the playbook",
        });
      const id = `playbook:${hash(input.commandId)}`;
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
        return yield* new PlaybookError({
          code: "invalid",
          detail: "Select a Squadron with exactly one project",
        });
      const project = yield* projects.getById(refs[0]!.projectId);
      if (Option.isNone(project))
        return yield* new PlaybookError({
          code: "not_found",
          detail: "Squadron project is unavailable",
        });
      const baseCommit = yield* Effect.tryPromise({
        try: () => resolveBase(project.value.workspaceRoot, baseRef),
        catch: failure,
      });
      const execution = yield* preparePlaybookExecution(
        `${config.stateDir}/playbook-runs`,
        library,
        yield* registry.getProviders,
        definition.agents ??
          Object.fromEntries(
            Object.entries(playbookAuthorities).map(([persona, authority]) => [
              persona,
              { persona, authority },
            ]),
          ),
        definition.source
          ? { source: definition.source, runtime: definition.runtime ?? "unsupported" }
          : undefined,
      );
      yield* Effect.try({
        try: () => playbookLibrary.snapshot(definition),
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
  const mutate = Effect.fn("PlaybookService.mutate")(function* (
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
    if (event.type !== "cancel" && !hasPlaybookSnapshots(run.execution))
      return yield* new PlaybookError({ code: "invalid", detail: legacyPlaybookMessage });
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
          return yield* new PlaybookError({
            code: "conflict",
            detail: "Displayed playbook definition has changed",
          });
        commandEvent = { type: "retry_restart" };
      } else {
        const availability = restartAvailability(run);
        if (!availability.available)
          return yield* new PlaybookError({ code: "conflict", detail: availability.reason });
        if (event.targetDefinitionHash !== availability.targetDefinitionHash)
          return yield* new PlaybookError({
            code: "conflict",
            detail: "Displayed playbook definition has changed",
          });
        if (!definition)
          return yield* new PlaybookError({
            code: "conflict",
            detail: "Playbook definition is unavailable",
          });
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
          return yield* new PlaybookError({ code: "conflict", detail: "Candidate code changed" });
        }
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
      return yield* new PlaybookError({ code: "conflict", detail: "Candidate code changed" });
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
                  "Playbook action did not confirm interruption during cancellation",
                  { playbookId: next.id, actionId: action.id, error },
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
        !isPlaybookThread(event.threadId) ||
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
  const recheckCandidates = Effect.fn("PlaybookService.recheckCandidates")(function* () {
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
          Effect.catch((error) => Effect.logError("Playbook worker stopped this pass", { error })),
        );
      yield* Queue.take(wake).pipe(Effect.raceFirst(Effect.sleep("1 second")));
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }), Effect.forkScoped);
  yield* Effect.gen(function* () {
    while (true) {
      yield* recheckCandidates().pipe(
        Effect.catch((error) => Effect.logError("Playbook candidate check failed", { error })),
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
      const current = playbookLibrary.catalog();
      const presentations: PlaybookDefinitionPresentation[] = current.map((entry) => {
        const definition = entry.definition;
        const requiredPersonas = Object.values(
          definition?.agents ??
            Object.fromEntries(
              Object.entries(playbookAuthorities).map(([persona, authority]) => [
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
          playbookLibrary.import(files, confirm);
          refreshDefinitions();
          return playbookLibrary.catalog();
        },
        catch: failure,
      }),
    setDefinitionEnabled: (id: string, enabled: boolean) =>
      Effect.try({
        try: () => {
          playbookLibrary.setEnabled(id, enabled);
          refreshDefinitions();
          return playbookLibrary.catalog();
        },
        catch: failure,
      }),
    removeDefinition: (id: string) =>
      Effect.try({
        try: () => {
          playbookLibrary.remove(id);
          refreshDefinitions();
          return playbookLibrary.catalog();
        },
        catch: failure,
      }),
    get: (id: string) => detail(id).pipe(Effect.mapError(failure)),
    readVersion: (id: string) => store.readVersion(id).pipe(Effect.mapError(failure)),
    artifact: (runId: string, artifactId: string) =>
      store.artifact(runId, artifactId).pipe(Effect.mapError(failure)),
  };
});
export class PlaybookService extends Context.Service<
  PlaybookService,
  Effect.Success<typeof makeService>
>()("t3/j5/playbook-definitions/Service/PlaybookService") {}
export const playbookLayer = Layer.effect(PlaybookService, makeService).pipe(
  Layer.provide(receiptLayer),
);
