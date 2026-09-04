import { assert, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import {
  candidateStatement,
  layer,
  QueuedRunCandidates,
  type CandidateQuery,
} from "./QueuedRunCandidates.ts";

const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("pages indexed starting-run candidates without scanning unrelated histories", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const candidates = yield* QueuedRunCandidates;
    const before = yield* sql`SELECT * FROM effect_sql_migrations`;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations`, before);
    assert.equal((yield* sql`SELECT * FROM j5_run_observability_migrations`).length, 1);

    const old = "2026-09-04T12:00:00.000Z";
    const newer = "2026-09-04T12:01:00.000Z";
    const recent = "2026-09-04T12:10:00.000Z";
    for (const [threadId, archived, deleted] of [
      ["active", null, null],
      ["archived", old, null],
      ["deleted", null, old],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES (${threadId}, 'project', 'candidate test', 'codex', 'full-access', 'default',
          ${old}, ${old}, ${archived}, ${deleted}, '{}')`;
    }
    let ordinal = 0;
    for (const [id, threadId, status, requestedAt] of [
      ["a", "active", "starting", old],
      ["b", "active", "starting", old],
      // The cursor must compare timestamp before id.
      ["0", "active", "starting", newer],
      ["recent", "active", "starting", recent],
      ["running", "active", "running", old],
      ["done", "active", "completed", old],
      ["archived", "archived", "starting", old],
      ["deleted", "deleted", "starting", old],
    ] as const) {
      ordinal += 1;
      const payload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
        id,
        threadId,
        ordinal,
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: `message-${id}`,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${id}, ${threadId}, ${ordinal}, 'codex', ${status}, ${requestedAt}, ${payload})`;
    }
    const first: CandidateQuery = {
      status: "starting",
      requestedBefore: DateTime.makeUnsafe(newer),
      limit: 1,
    };
    const second = {
      ...first,
      after: { requestedAt: DateTime.makeUnsafe(old), runId: RunId.make("a") },
    };
    const third = {
      ...first,
      after: { requestedAt: DateTime.makeUnsafe(old), runId: RunId.make("b") },
    };
    assert.deepEqual(
      (yield* candidates.list(first)).map((run) => run.id),
      ["a"],
    );
    assert.deepEqual(
      (yield* candidates.list(second)).map((run) => run.id),
      ["b"],
    );
    assert.deepEqual(
      (yield* candidates.list(third)).map((run) => run.id),
      ["0"],
    );
    assert.deepEqual(
      (yield* candidates.list({ ...first, limit: 100 })).map((run) => run.id),
      ["a", "b", "0"],
    );
    assert.deepEqual(
      yield* candidates.list({
        ...first,
        after: { requestedAt: DateTime.makeUnsafe(newer), runId: RunId.make("0") },
      }),
      [],
    );
    for (const input of [first, second]) {
      const [query, params] = candidateStatement(sql, input).compile();
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes("SEARCH r USING INDEX j5_run_observability_status_requested_run_idx"),
        ),
      );
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    }
  }).pipe(Effect.provide(testLayer)),
);
