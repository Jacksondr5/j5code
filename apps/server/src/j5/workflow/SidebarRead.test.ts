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
        yield* sql`INSERT INTO j5_workflow_runs VALUES (${`run-${index}`}, ${index === 52 ? "other" : "selected"}, 3, ${index === 0 ? "waiting_approval" : "completed"}, ${payload})`;
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
      yield* sql`INSERT INTO j5_workflow_actions(id, run_id, status, identity, payload)
        VALUES ('action-parent', 'run-0', 'completed', ${`${workflowThreadId}/provider-run`}, '{}')`;
      assert.deepEqual(yield* readWorkflowThreadParent(workflowThreadId), {
        runId: "run-0",
        squadronId: "selected",
        title: "Change 0",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
