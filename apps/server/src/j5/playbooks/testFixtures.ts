import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { createAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";

export const seedPlaybookOwners = Effect.fn(function* (owners: ReadonlyArray<string>) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const owner of owners) {
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (${owner}, 'project:playbook-test', 'Owner', 'codex', 'full-access', 'default',
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '{}')`;
  }
});

/** Adds personas to the environment's real library through its own API, then turns some off. */
export const seedPersonas = Effect.fn(function* (
  personas: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>,
) {
  const { stateDir } = yield* ServerConfig;
  const library = createAgentPersonaLibrary({
    fs: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    stateDir,
  });
  for (const { id, enabled } of personas) {
    yield* library.createPersona({
      id,
      displayName: id,
      description: `The ${id} persona.`,
      instructions: `You are ${id}.`,
      authorityPolicy: "read-only",
      modelRoute: [
        { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5", reasoningEffort: "high" },
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5-5",
          reasoningEffort: "high",
        },
      ],
    });
    if (!enabled) yield* library.setEnabled(id, false);
  }
  return stateDir;
});
