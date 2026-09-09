import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { readWorkflowEntries, readWorkflowThreadParent } from "./SidebarRead.ts";
import { runWorkflowMigrations } from "./Migrations.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "lists bounded workflow titles, prioritizes gates and searches within the selected Squadron without loading evidence",
  () =>
    Effect.gen(function* () {
      yield* runWorkflowMigrations();
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 53; index++) {
        const payload = yield* encodeJson({
          inputs: { request: `Change ${index}` },
          phase: "plan_approval",
          gate: { revision: 3 },
          artifacts: ["private evidence"],
        });
        const status = index === 0 ? "waiting_approval" : "completed";
        yield* sql`INSERT INTO j5_workflow_runs(
          id, definition_id, definition_version, definition_hash, squadron_id,
          project_id, title, phase, gate_revision, activity_at, status_priority,
          revision, read_version, status, payload
        ) VALUES (
          ${`run-${index}`}, 'test', 1, 'hash', ${index === 52 ? "other" : "selected"},
          'project', ${`Change ${index}`}, 'plan_approval', 3, ${index},
          ${status === "waiting_approval" ? 0 : 5}, 3, 1, ${status}, ${payload}
        )`;
      }
      const first = yield* readWorkflowEntries("selected", "", 0);
      assert.equal(first.runs.length, 50);
      assert.equal(first.hasMore, true);
      assert.equal(first.total, 52);
      assert.equal(first.waitingApprovalCount, 1);
      assert.equal(first.runs[0]!.id, "run-0");
      assert.equal(first.runs[0]!.gateRevision, 3);
      assert.isFalse((yield* encodeJson(first)).includes("private evidence"));
      const second = yield* readWorkflowEntries("selected", "", 50);
      assert.equal(second.runs.length, 2);
      assert.equal(second.hasMore, false);
      assert.equal(new Set([...first.runs, ...second.runs].map((run) => run.id)).size, 52);
      const search = yield* readWorkflowEntries("selected", "CHANGE 51", 0);
      assert.deepEqual(
        search.runs.map((run) => run.id),
        ["run-51"],
      );
      assert.equal((yield* readWorkflowEntries("selected", "Change 52", 0)).runs.length, 0);
      assert.equal((yield* readWorkflowEntries("", "Change 52", 0)).runs.length, 1);
      const workflowThreadId = `thread:wf:${"a".repeat(64)}`;
      yield* sql`INSERT INTO j5_workflow_actions(
        id, run_id, phase, revision, task, attempt, kind, adapter, status,
        deadline, input_hash, identity
      ) VALUES (
        'action-parent', 'run-0', 'build', 1, 'builder', 1, 'agent', 'persona',
        'completed', 1000, 'input-hash', ${`${workflowThreadId}/provider-run`}
      )`;
      assert.deepEqual(yield* readWorkflowThreadParent(workflowThreadId), {
        runId: "run-0",
        squadronId: "selected",
        title: "Change 0",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("uses scoped ordering indexes for a 2,000-run fixture", () =>
  Effect.gen(function* () {
    yield* runWorkflowMigrations();
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodeJson({ compact: true });
    yield* Effect.forEach(
      Array.from({ length: 2_000 }, (_, index) => index),
      (index) => sql`INSERT INTO j5_workflow_runs(
        id, definition_id, definition_version, definition_hash, squadron_id,
        project_id, title, phase, gate_revision, activity_at, status_priority,
        revision, read_version, status, payload
      ) VALUES (
        ${`fixture-${index}`}, 'test', 1, 'hash', ${index % 2 ? "red" : "blue"},
        'project', ${`Fixture ${index}`}, 'build', NULL, ${index}, 1, 1, 1, 'running', ${payload}
      )`,
      { concurrency: 1 },
    );
    const result = yield* readWorkflowEntries("blue", "", 950, 50);
    assert.equal(result.total, 1_000);
    assert.equal(result.runs.length, 50);
    const plan = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM j5_workflow_runs
       WHERE squadron_id=? ORDER BY status_priority, activity_at DESC, creation_sequence DESC
       LIMIT ? OFFSET ?`,
      ["blue", 51, 950],
    );
    assert.isTrue(plan.some(({ detail }) => detail.includes("j5_workflow_runs_v2_squadron_order")));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
