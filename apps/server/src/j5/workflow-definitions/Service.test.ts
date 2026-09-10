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
import { makeStore } from "../workflow/Store.ts";
import { runWorkflowMigrations } from "../workflow/Migrations.ts";
import { workflowProvider, definitions } from "../workflow/testFixtures.ts";
import { readWorkflowExecution } from "../workflow/Execution.ts";
import { makeService } from "./Service.ts";

// Exercise durable start/receipt behavior without running external workspace or agent actions.
vi.mock("../workflow/Worker.ts", () => ({ makeWorker: () => ({ drain: () => Effect.void }) }));
vi.mock("./fh/GitWorkspace.ts", async (original) => ({
  ...(await original<typeof import("./fh/GitWorkspace.ts")>()),
  resolveBase: async () => "base-commit",
}));
const projectId = ProjectId.make("project:test");
const deps = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({ streamDomainEvents: Stream.never }),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(CommandReceiptStoreV2)({}),
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([workflowProvider]) }),
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
      yield* runWorkflowMigrations();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const folder = path.join(config.stateDir, "personas");
      yield* fs.makeDirectory(folder, { recursive: true });
      for (const definition of definitions)
        yield* fs.writeFileString(
          path.join(folder, `${definition.id}.yaml`),
          stringify(definition),
        );
      const service = yield* makeService;
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
      assert.lengthOf(Object.keys(readWorkflowExecution(accepted.execution).personas), 7);
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
          layerTest("/test", { prefix: "workflow-start-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
