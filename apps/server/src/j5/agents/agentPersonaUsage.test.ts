import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { agentPersonaUsage } from "./agentPersonaUsage.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const assignment = (personaId: string, driver: string, model: string) =>
  encodeJson({
    agentPersonaAssignment: {
      personaId,
      definitionVersion: 1,
      authorityPolicy: "read-only",
      resolvedRoute: "primary",
      resolvedDriver: driver,
      resolvedModelSelection: { instanceId: driver, model },
    },
  });

it.effect("aggregates threads, runs, durations, tokens, and routes per saved agent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* agentPersonaUsage(), { personas: [] });

    const t0 = "2026-09-10T10:00:00.000Z";
    const t1 = "2026-09-10T11:00:00.000Z";
    for (const [threadId, payload, createdAt, deletedAt] of [
      ["scout-a", assignment("scout", "codex", "gpt-5.6-terra"), t0, null],
      ["scout-b", assignment("scout", "claudeAgent", "claude-opus-5"), t1, null],
      ["scout-deleted", assignment("scout", "codex", "gpt-5.6-terra"), t1, t1],
      ["critic-a", assignment("critic", "codex", "gpt-5.6-terra"), t0, null],
      ["plain", "{}", t0, null],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES (${threadId}, 'project', 'usage test', 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt}, NULL, ${deletedAt}, ${payload})`;
    }
    let ordinal = 0;
    for (const [runId, threadId, status, requestedAt, completedAt] of [
      ["r1", "scout-a", "completed", t0, "2026-09-10T10:01:00.000Z"],
      ["r2", "scout-a", "completed", t0, "2026-09-10T10:03:00.000Z"],
      ["r3", "scout-b", "failed", t1, "2026-09-10T11:00:30.000Z"],
      ["r4", "scout-b", "running", t1, null],
      ["r5", "scout-deleted", "completed", t1, "2026-09-10T11:59:00.000Z"],
      ["r6", "plain", "completed", t0, t1],
    ] as const) {
      ordinal += 1;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
        VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', NULL, ${status}, ${requestedAt}, ${completedAt}, '{}')`;
    }
    for (const [turnId, threadId, payload] of [
      [
        "p1",
        "scout-a",
        encodeJson({ turnTokenUsage: { usedTokens: 10, inputTokens: 100, outputTokens: 20 } }),
      ],
      [
        "p2",
        "scout-b",
        encodeJson({ turnTokenUsage: { usedTokens: 10, inputTokens: 50, outputTokens: 5 } }),
      ],
      ["p3", "critic-a", "{}"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
        VALUES (${turnId}, ${threadId}, ${`pt-${threadId}`}, 'node', NULL, 1, 'completed', ${t0}, ${t1}, ${payload})`;
    }

    assert.deepEqual(yield* agentPersonaUsage(), {
      personas: [
        {
          personaId: "scout",
          threads: 2,
          runs: 4,
          completedRuns: 2,
          failedRuns: 1,
          averageRunDurationMs: 120_000,
          lastLaunchedAt: t1,
          inputTokens: 150,
          outputTokens: 25,
          routes: [
            { driver: claude, model: "claude-opus-5", threads: 1 },
            { driver: codex, model: "gpt-5.6-terra", threads: 1 },
          ],
        },
        {
          personaId: "critic",
          threads: 1,
          runs: 0,
          completedRuns: 0,
          failedRuns: 0,
          averageRunDurationMs: null,
          lastLaunchedAt: t0,
          inputTokens: null,
          outputTokens: null,
          routes: [{ driver: codex, model: "gpt-5.6-terra", threads: 1 }],
        },
      ],
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
