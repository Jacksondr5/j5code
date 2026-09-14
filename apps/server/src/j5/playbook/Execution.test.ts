// @effect-diagnostics preferSchemaOverJson:off - simulate a process boundary and deliberately corrupt persisted bytes.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { stringify } from "yaml";
import { createAgentPersonaLibrary, definitionDigest } from "../agents/agentPersonaLibrary.ts";
import { resolveAgentPersonaLaunch } from "../agents/agentPersonaOrchestration.ts";
import { resolveAgentPersonaRuntime } from "../agents/agentPersonaRuntime.ts";
import { preparePlaybookExecution, hasPlaybookSnapshots } from "./Execution.ts";

import { playbookProvider, definitions } from "./testFixtures.ts";
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "playbook-personas-" });
  const library = createAgentPersonaLibrary({ fs, path, stateDir });
  yield* fs.makeDirectory(path.join(stateDir, "personas"));
  for (const definition of definitions)
    yield* fs.writeFileString(
      path.join(stateDir, "personas", `${definition.id}.yaml`),
      stringify(definition),
    );
  return { fs, path, stateDir, library };
});

it.effect(
  "pins every role once and reuses exact assignments after same-version edits, disabling, removal and restart",
  () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, library } = yield* fixture;
      let reads = 0;
      const execution = yield* preparePlaybookExecution(
        "/playbook",
        {
          ...library,
          catalog: () => {
            reads++;
            return library.catalog();
          },
        },
        [playbookProvider],
      );
      assert.equal(reads, 1);
      assert.isTrue(hasPlaybookSnapshots(execution));
      yield* fs.writeFileString(
        path.join(stateDir, "personas", "scout.yaml"),
        stringify({ ...definitions[0], instructions: "Changed without a version bump" }),
      );
      yield* library.importFiles({
        files: [
          {
            name: "builder.yaml",
            content: stringify(definitions.find(({ id }) => id === "builder")),
          },
        ],
        replaceExisting: true,
      });
      yield* library.setImportedEnabled("builder", false);
      yield* library.removeAgent("critic");
      yield* fs.remove(path.join(stateDir, "personas"), { recursive: true });
      const restarted = createAgentPersonaLibrary({ fs, path, stateDir });
      // Persisted JSON is the only execution input supplied to the restarted process.
      const saved = JSON.parse(JSON.stringify(execution)) as typeof execution;
      for (const [id, assignment] of Object.entries(saved.personas)) {
        const launch = yield* resolveAgentPersonaLaunch(
          {
            preparedPersonaAssignment: assignment,
            modelSelection: assignment.resolvedModelSelection,
          },
          { replay: false, providers: Effect.succeed([playbookProvider]), library: restarted },
        );
        assert.deepEqual(launch.agentPersonaAssignment, assignment);
        const definition = yield* restarted.readSnapshot(assignment);
        assert.equal(definition.instructions, `Original ${id}`);
        assert.equal(assignment.definitionDigest, definitionDigest(definition));
        const policy = yield* resolveAgentPersonaRuntime(
          { agentPersonaAssignment: assignment, runtimeMode: "full-access" },
          restarted,
        );
        assert.include(
          ("agentPersonaInstructions" in policy ? policy.agentPersonaInstructions : "")!,
          `Original ${id}`,
        );
      }
      assert.isTrue(
        (yield* Effect.exit(preparePlaybookExecution("/new", restarted, [playbookProvider])))
          ._tag === "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("blocks corrupt snapshots and unavailable pinned instances without rerouting", () =>
  Effect.gen(function* () {
    const { fs, path, stateDir, library } = yield* fixture;
    const execution = yield* preparePlaybookExecution("/playbook", library, [playbookProvider]);
    const assignment = execution.personas.scout;
    const launch = (providers: ReadonlyArray<ServerProvider>) =>
      resolveAgentPersonaLaunch(
        {
          preparedPersonaAssignment: assignment,
          modelSelection: assignment.resolvedModelSelection,
        },
        { replay: false, providers: Effect.succeed(providers), library },
      );
    const unavailable = yield* launch([
      { ...playbookProvider, instanceId: ProviderInstanceId.make("another-codex") },
    ]).pipe(Effect.flip);
    assert.include(String(unavailable), "Pinned provider/model");
    yield* fs.writeFileString(
      path.join(stateDir, "agent-persona-snapshots", `${assignment.definitionDigest}.json`),
      JSON.stringify({ ...(yield* library.readSnapshot(assignment)), instructions: "Tampered" }),
    );
    assert.include(String(yield* launch([playbookProvider]).pipe(Effect.flip)), "does not match");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects missing, disabled, invalid and unavailable roles before playbook persistence",
  () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, library } = yield* fixture;
      assert.isFalse(hasPlaybookSnapshots({ stateRoot: "/legacy" }));
      assert.isTrue(
        (yield* Effect.exit(preparePlaybookExecution("/playbook", library, [])))._tag === "Failure",
      );
      yield* library.importFiles({
        files: [
          {
            name: "builder.yaml",
            content: stringify(definitions.find(({ id }) => id === "builder")),
          },
        ],
        replaceExisting: true,
      });
      yield* library.setImportedEnabled("builder", false);
      assert.include(
        String(
          yield* preparePlaybookExecution("/playbook", library, [playbookProvider]).pipe(
            Effect.flip,
          ),
        ),
        "disabled",
      );
      yield* library.setImportedEnabled("builder", true);
      yield* fs.writeFileString(
        path.join(stateDir, "personas", "scout.yaml"),
        "invalid: definition",
      );
      assert.include(
        String(
          yield* preparePlaybookExecution("/playbook", library, [playbookProvider]).pipe(
            Effect.flip,
          ),
        ),
        "Invalid persona file",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
