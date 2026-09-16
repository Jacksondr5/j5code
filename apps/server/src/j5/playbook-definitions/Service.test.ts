import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { stringify } from "yaml";
import { ServerConfig, layerTest } from "../../config.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { SquadronProjectReferences } from "../a2a/SquadronProjectReferences.ts";
import { makeAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import { makeStore } from "../playbook/Store.ts";
import { runPlaybookMigrations } from "../playbook/Migrations.ts";
import { playbookProvider, definitions } from "../playbook/testFixtures.ts";
import { readPlaybookExecution } from "../playbook/Execution.ts";
import { makeService } from "./Service.ts";
import { compileYamlPlaybook } from "./Yaml.ts";
import { git, candidate } from "./fh/GitWorkspace.ts";
import type { Run } from "@j5/playbook-contracts";

// Exercise durable start/receipt behavior without running external workspace or agent actions.
vi.mock("../playbook/Worker.ts", () => ({ makeWorker: () => ({ drain: () => Effect.void }) }));
vi.mock("./fh/GitWorkspace.ts", async (original) => ({
  ...(await original<typeof import("./fh/GitWorkspace.ts")>()),
  resolveBase: async () => "base-commit",
}));
const projectId = ProjectId.make("project:test");
const deps = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({ streamDomainEvents: Stream.never }),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(CommandReceiptStoreV2)({}),
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([playbookProvider]) }),
  Layer.mock(SquadronProjectReferences)({
    listForSquadron: (squadronId) =>
      Effect.succeed([
        { squadronId, projectId, ordinal: 0, createdAt: "2026-09-09T00:00:00.000Z" },
      ]),
  }),
  Layer.mock(ProjectService)({
    getById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Test",
          workspaceRoot: "/test",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          scripts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
          deletedAt: null,
        }),
      ),
  }),
);
it.effect(
  "serializes duplicate starts, replays receipts after library changes and restart, and rejects legacy continuation",
  () =>
    Effect.gen(function* () {
      yield* runPlaybookMigrations();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const folder = path.join(config.stateDir, "personas");
      const service = yield* makeService;
      const presentation = () =>
        service.definitions.pipe(
          Effect.map((items) => items.find(({ id }) => id === "fh-development")!),
        );
      const unavailable = yield* presentation();
      assert.isFalse(unavailable.enabled);
      assert.include(
        unavailable.diagnostics?.join("\n") ?? "",
        "Missing or disabled agent personas",
      );
      const personaLibrary = yield* makeAgentPersonaLibrary;
      yield* personaLibrary.importFiles({
        files: definitions.map((definition) => ({
          name: `${definition.id}.yaml`,
          content: stringify(definition),
        })),
        replaceExisting: false,
      });
      assert.isTrue((yield* presentation()).enabled);
      yield* personaLibrary.setImportedEnabled("scout", false);
      const disabled = yield* presentation();
      assert.isFalse(disabled.enabled);
      assert.include(disabled.diagnostics?.join("\n") ?? "", "scout");
      yield* personaLibrary.setImportedEnabled("scout", true);
      assert.isTrue((yield* presentation()).enabled);
      const input = {
        commandId: "start",
        definitionId: "fh-development",
        squadronId: "s",
        expectedRevision: 0,
        request: "Change",
        baseRef: "main",
        evidence: [],
      };
      const [first, duplicate] = yield* Effect.all([service.start(input), service.start(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(first, duplicate);
      assert.notProperty(first, "execution");
      const store = yield* makeStore;
      const accepted = yield* store.get(first.id);
      assert.lengthOf(Object.keys(readPlaybookExecution(accepted.execution).personas), 7);
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "scout.yaml"), "invalid: now");
      assert.deepEqual(yield* service.start(input), first);
      const restarted = yield* makeService;
      assert.deepEqual(yield* restarted.start(input), first);
      assert.deepEqual((yield* store.get(first.id)).execution, accepted.execution);
      const failed = yield* restarted.start({ ...input, commandId: "new" }).pipe(Effect.flip);
      assert.include(failed.detail, "Invalid persona file");
      const legacy = {
        ...accepted,
        id: "legacy",
        execution: {},
        definitionVersion: 2,
        revision: 0,
      };
      yield* store.command(
        {
          commandId: "legacy-fixture",
          runId: legacy.id,
          expectedRevision: 0,
          initial: legacy,
          event: { type: "enter" },
          now: 0,
        },
        undefined,
      );
      const old = yield* store.get(legacy.id);
      assert.equal((yield* restarted.get(legacy.id)).id, legacy.id);
      const rejected = yield* restarted
        .mutate(legacy.id, "legacy-retry", old.revision, { type: "retry" })
        .pipe(Effect.flip);
      assert.include(rejected.detail, "Start a fresh task");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          deps,
          NodeSqliteClient.layerMemory(),
          layerTest("/test", { prefix: "playbook-start-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect("edits custom publication through the service and invalidates changed candidates", () =>
  Effect.gen(function* () {
    yield* runPlaybookMigrations();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const service = yield* makeService;
    const personas = yield* makeAgentPersonaLibrary;
    yield* personas.importFiles({
      files: definitions.map((definition) => ({
        name: `${definition.id}.yaml`,
        content: stringify(definition),
      })),
      replaceExisting: false,
    });
    const source = yield* fs.readFileString(
      new URL(
        "../../../../../.agents/skills/j5-new-playbook/examples/publication.yaml",
        import.meta.url,
      ).pathname,
    );
    const definition = compileYamlPlaybook(source);
    const incomplete = source
      .replace(/  - id: prepare-publication[\s\S]*?(?=  - id: pr-approval)/, "")
      .replace("completed: prepare-publication", "completed: pr-approval")
      .replace(", prepare-publication]", "]");
    const rejectedImport = yield* service
      .importDefinitions([{ name: "incomplete.yaml", content: incomplete }])
      .pipe(Effect.flip);
    assert.include(
      rejectedImport.detail,
      "incomplete.yaml:phases: publication requires exactly one preparation step",
    );
    yield* service.importDefinitions([{ name: "custom.yaml", content: source }]);
    assert.deepEqual(
      (yield* service.definitions).find((item) => item.id === definition.id)?.publication,
      definition.publication,
    );
    const started = yield* service.start({
      commandId: "custom-start",
      definitionId: definition.id,
      squadronId: "s",
      expectedRevision: 0,
      request: "fix",
      baseRef: "main",
      evidence: [],
    });
    const store = yield* makeStore;
    let run: Run = yield* store.get(started.id);
    const complete = Effect.fn(function* (output: unknown) {
      const action = run.actions.find((item) => item.status === "pending")!;
      run = yield* store.command(
        {
          commandId: `result:${action.id}`,
          runId: run.id,
          expectedRevision: run.revision,
          event: { type: "result", actionId: action.id, output },
          now: 1,
        },
        definition,
      );
    });
    const repository = path.join(config.stateDir, "repo");
    yield* Effect.promise(async () => {
      await git(config.stateDir, ["init", "-b", "main", repository]);
      await git(repository, ["config", "user.name", "Fixture"]);
      await git(repository, ["config", "user.email", "fixture@example.test"]);
      await git(repository, ["commit", "--allow-empty", "-m", "initial"]);
      await git(repository, ["tag", "base-commit"]);
    });
    yield* complete({ worktree: repository, branch: "main", baseCommit: "base-commit" });
    for (let index = 0; index < 3; index++)
      yield* complete({ summary: "Fix", body: "Checked", evidence: [], unknowns: [] });
    yield* fs.writeFileString(path.join(repository, "fix.txt"), "fix");
    const snapshot = yield* Effect.promise(() => candidate(repository, "base-commit"));
    yield* complete({
      ...snapshot,
      diff: "recorded diff",
      repository: "fixture",
      baseBranch: "main",
      headBranch: "main",
      commitMessage: "fix: test",
      title: "Fix",
      body: "Checked",
    });
    const originalGate = run.gate!;
    yield* service.mutate(run.id, "edit", run.revision, {
      type: "edit_gate",
      gateRevision: originalGate.revision,
      artifactHash: originalGate.artifactHash,
      actor: "human",
      content: { commitMessage: "fix: edited", title: "Edited", body: "" },
    });
    run = yield* store.get(run.id);
    assert.notEqual(run.gate!.revision, originalGate.revision);
    assert.notEqual(run.gate!.artifactHash, originalGate.artifactHash);
    const stale = yield* service
      .mutate(run.id, "stale", run.revision, {
        type: "decision",
        decision: {
          gateRevision: originalGate.revision,
          artifactHash: originalGate.artifactHash,
          actor: "human",
          decision: "approve",
          feedback: "",
        },
      })
      .pipe(Effect.flip);
    assert.include(stale.detail, "Gate or reviewed artifact has changed");
    const gate = run.gate!;
    yield* fs.writeFileString(path.join(repository, "fix.txt"), "changed");
    const changed = yield* service
      .mutate(run.id, "approve-changed", run.revision, {
        type: "decision",
        decision: {
          gateRevision: gate.revision,
          artifactHash: gate.artifactHash,
          actor: "human",
          decision: "approve",
          feedback: "",
        },
      })
      .pipe(Effect.flip);
    assert.include(changed.detail, "Candidate code changed");
    run = yield* store.get(run.id);
    assert.equal(run.phase, "development");
    assert.isNull(run.gate);
    assert.isEmpty(run.approvals);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        deps,
        NodeSqliteClient.layerMemory(),
        layerTest("/test", { prefix: "custom-publication-service-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
