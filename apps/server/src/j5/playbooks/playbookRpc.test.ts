import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
} from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS, type PlaybookError } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { ServerConfig } from "../../config.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makePlaybookStore, playbookError } from "./PlaybookStore.ts";
import { makePlaybookRpcHandlers, PLAYBOOK_RPC_SCOPES } from "./playbookRpc.ts";
import { seedPlaybookOwners } from "./testFixtures.ts";

const owner = ThreadId.make("thread:playbook-rpc:owner");
const otherOwner = ThreadId.make("thread:playbook-rpc:other");
const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "j5-playbook-rpc-" }).pipe(
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
  ),
);
const definition = (title = "Shared playbook") => ({
  title,
  description: "A shared workflow.",
  steps: [
    { id: "first", title: "First step", prompt: "PRIVATE_FIRST_PROMPT" },
    { id: "last", title: "Last step", prompt: "PRIVATE_LAST_PROMPT" },
  ],
});
const fixture = Effect.gen(function* () {
  yield* runJ5A2AMigrations();
  yield* seedPlaybookOwners([owner, otherOwner]);
  const store = yield* makePlaybookStore;
  yield* store.saveDefinition({
    name: "demo",
    yaml: `# preserve comment\n${stringify(definition())}`,
  });
  const handlers = yield* makePlaybookRpcHandlers({ store });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const filename = path.join(stateDir, "playbooks/demo.yaml");
  return { store, handlers, fs, path, stateDir, filename };
});
const codeOf = <A>(call: Effect.Effect<A, PlaybookError>) =>
  call.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );
const assertPromptFree = (value: unknown) => {
  assert.notInclude(JSON.stringify(value), "PRIVATE_");
  assert.notInclude(JSON.stringify(value), '"prompt"');
};

it("keeps library reads read-scoped and writes operate-scoped", () => {
  for (const method of [
    J5_PLAYBOOK_WS_METHODS.readLibrary,
    J5_PLAYBOOK_WS_METHODS.readSources,
    J5_PLAYBOOK_WS_METHODS.exportPlaybook,
    J5_PLAYBOOK_WS_METHODS.listRuns,
    J5_PLAYBOOK_WS_METHODS.listThreadRuns,
    J5_PLAYBOOK_WS_METHODS.subscribeChanges,
  ]) {
    assert.equal(requiredScopeForRpcMethod(method), AuthOrchestrationReadScope);
    assert.equal(PLAYBOOK_RPC_SCOPES[method], AuthOrchestrationReadScope);
  }
  for (const method of [
    J5_PLAYBOOK_WS_METHODS.savePlaybook,
    J5_PLAYBOOK_WS_METHODS.setFolders,
    J5_PLAYBOOK_WS_METHODS.renamePlaybook,
    J5_PLAYBOOK_WS_METHODS.deletePlaybook,
  ]) {
    assert.equal(requiredScopeForRpcMethod(method), AuthOrchestrationOperateScope);
    assert.equal(PLAYBOOK_RPC_SCOPES[method], AuthOrchestrationOperateScope);
  }
});

it.effect("lists the environment library without project services or creating a run", () =>
  Effect.gen(function* () {
    const { handlers, fs, path, stateDir } = yield* fixture;
    const local = path.join(stateDir, "project/.j5/playbooks");
    yield* fs.makeDirectory(local, { recursive: true });
    yield* fs.writeFileString(
      path.join(local, "demo.yaml"),
      stringify(definition("Local override")),
    );
    const library = yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({});
    assert.equal(library.playbooks.length, 1);
    assert.equal(library.playbooks[0]?.title, "Shared playbook");
    assert.equal(library.playbooks[0]?.source?.kind, "environment");
    assertPromptFree(library);
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM j5_playbook_run`)[0]?.count,
      0,
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("shows invalid files and live edits without exposing prompt bodies", () =>
  Effect.gen(function* () {
    const { handlers, fs, filename } = yield* fixture;
    yield* fs.writeFileString(filename, "title: [broken");
    assert.equal(
      (yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({})).playbooks[0]?.issue?.code,
      "invalid_definition",
    );
    yield* fs.writeFileString(filename, stringify(definition("Updated live")));
    const library = yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({});
    assert.equal(library.playbooks[0]?.title, "Updated live");
    assertPromptFree(library);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("exports original YAML and renames a title without moving the active run", () =>
  Effect.gen(function* () {
    const { store, handlers, filename } = yield* fixture;
    const run = yield* store.start(owner, "demo", "start");
    const exported = yield* handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook]({ name: "demo" });
    assert.equal(exported.fileName, "demo.yaml");
    assert.include(exported.yaml, "# preserve comment");
    yield* handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({ name: "demo", title: "Renamed" });
    const current = yield* store.current(owner, run.runId);
    assert.equal(current.title, "Renamed");
    assert.equal(current.definitionPath, filename);
    assert.equal(current.currentStepId, "first");
    assert.equal(
      yield* codeOf(handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "demo" })),
      "in_use",
    );
    yield* store.mutate(owner, {
      operation: "cancel",
      runId: run.runId,
      client_request_id: "cancel",
    });
    assert.deepStrictEqual(
      yield* handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "demo" }),
      { deleted: true },
    );
    assert.equal((yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({})).playbooks.length, 0);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("lists live progress by owner and status, without prompts", () =>
  Effect.gen(function* () {
    const { store, handlers } = yield* fixture;
    const first = yield* store.start(owner, "demo", "first");
    const second = yield* store.start(otherOwner, "demo", "second");
    yield* store.mutate(owner, {
      operation: "next",
      runId: first.runId,
      expectedStepId: "first",
      client_request_id: "next",
    });
    const progress = yield* handlers[J5_PLAYBOOK_WS_METHODS.listThreadRuns]({ threadId: owner });
    assert.equal(progress.runs[0]?.position, 2);
    assertPromptFree(progress);
    yield* store.mutate(owner, {
      operation: "complete",
      runId: first.runId,
      expectedStepId: "last",
      client_request_id: "done",
    });
    const active = yield* handlers[J5_PLAYBOOK_WS_METHODS.listRuns]({ status: "active" });
    assert.equal(active.total, 1);
    assert.equal(active.runs[0]?.runId, second.runId);
    assert.equal((yield* handlers[J5_PLAYBOOK_WS_METHODS.listRuns]({})).total, 2);
    assertPromptFree(active);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("rejects traversal and invalid renames, but can delete broken YAML", () =>
  Effect.gen(function* () {
    const { handlers, fs, filename } = yield* fixture;
    assert.equal(
      yield* codeOf(handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook]({ name: "../demo" })),
      "invalid_name",
    );
    assert.equal(
      yield* codeOf(handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "demo/other" })),
      "invalid_name",
    );
    assert.equal(
      yield* codeOf(handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({ name: "demo", title: " " })),
      "invalid_title",
    );
    yield* fs.writeFileString(filename, "title: [broken");
    assert.equal(
      yield* codeOf(
        handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({ name: "demo", title: "Nope" }),
      ),
      "invalid_definition",
    );
    yield* handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "demo" });
    assert.isFalse(yield* fs.exists(filename));
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("manages configured sources without a project and enforces read-only definitions", () =>
  Effect.gen(function* () {
    const { handlers, fs, path, stateDir } = yield* fixture;
    const folder = path.join(stateDir, "external");
    yield* fs.makeDirectory(folder);
    yield* fs.writeFileString(
      path.join(folder, "external.yaml"),
      stringify(definition("External")),
    );
    yield* handlers[J5_PLAYBOOK_WS_METHODS.setFolders]({ folders: [folder] });
    const source = { kind: "folder", path: folder } as const;
    const library = yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({});
    assert.equal(library.playbooks.length, 2);
    assert.equal(
      yield* codeOf(handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "external", source })),
      "read_only",
    );
    const exported = yield* handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook]({
      name: "external",
      source,
    });
    yield* handlers[J5_PLAYBOOK_WS_METHODS.savePlaybook]({ name: "copied", yaml: exported.yaml });
    yield* handlers[J5_PLAYBOOK_WS_METHODS.setFolders]({ folders: [] });
    assert.deepStrictEqual(
      (yield* handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({})).playbooks.map(
        (entry) => entry.name,
      ),
      ["copied", "demo"],
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps storage error details out of client responses", () =>
  Effect.gen(function* () {
    const { store } = yield* fixture;
    const refused = Effect.fail(playbookError("operation_failed", "EACCES /private/secret-path"));
    const handlers = yield* makePlaybookRpcHandlers({
      store: {
        ...store,
        discover: () => refused,
        exportDefinition: () => refused,
        removeDefinition: () => refused,
        renameDefinition: () => refused,
      },
    });
    const calls: Array<Effect.Effect<unknown, PlaybookError>> = [
      handlers[J5_PLAYBOOK_WS_METHODS.readLibrary]({}),
      handlers[J5_PLAYBOOK_WS_METHODS.exportPlaybook]({ name: "demo" }),
      handlers[J5_PLAYBOOK_WS_METHODS.deletePlaybook]({ name: "demo" }),
      handlers[J5_PLAYBOOK_WS_METHODS.renamePlaybook]({ name: "demo", title: "New" }),
    ];
    for (const call of calls) {
      yield* call.pipe(
        Effect.match({
          onSuccess: () => assert.fail("Expected a storage refusal"),
          onFailure: (error) => {
            assert.equal(error.code, "operation_failed");
            assert.notInclude(error.message, "/private");
          },
        }),
      );
    }
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
