import {
  AgentPersonaPickConstraint,
  ProviderOptionSelection,
  RuntimeMode,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ApprovedPick = Schema.Struct({
  stepIds: Schema.Array(Schema.String),
  retryStepId: Schema.optionalKey(Schema.String),
  projectId: Schema.String,
  definitionDigest: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      driver: Schema.String,
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
      runtimeMode: RuntimeMode,
      sandbox: Schema.optional(Schema.Literals(["readOnly", "workspaceWrite"])),
      constraints: Schema.Array(AgentPersonaPickConstraint),
    }),
  ),
});
export type ApprovedPick = typeof ApprovedPick.Type;
const PickScopes = Schema.fromJsonString(Schema.Record(Schema.String, ApprovedPick));
export const encodePickScopes = Schema.encodeSync(PickScopes);
export const decodePickScopes = Schema.decodeUnknownEffect(PickScopes);

export type StaffingRequest = {
  owner: ThreadId;
  projectId: ProjectId;
  requestId: string;
  stepId: string;
  personaId: string;
};

const activeApproval = (sql: SqlClient.SqlClient, request: StaffingRequest) => sql`
  FROM j5_playbook_run run
  JOIN j5_playbook_checkpoint checkpoint ON checkpoint.run_id = run.run_id
  JOIN orchestration_v2_projection_threads thread ON thread.thread_id = run.owner_thread_id
  WHERE run.owner_thread_id = ${request.owner} AND run.status = 'active'
    AND thread.project_id = ${request.projectId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
    AND checkpoint.request_id = ${request.requestId} AND checkpoint.status = 'approved'
    AND checkpoint.persona_picks_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM json_each(checkpoint.persona_picks_json) pick
      JOIN json_each(pick.value, '$.stepIds') named
      WHERE pick.key = ${request.personaId} AND named.value = ${request.stepId}
        AND json_extract(pick.value, '$.projectId') = ${request.projectId})
    AND EXISTS (SELECT 1 FROM json_each(run.definition_json, '$.steps') step
      WHERE json_extract(step.value, '$.id') = ${request.stepId}
        AND json_extract(step.value, '$.persona') = ${request.personaId})
    AND NOT EXISTS (SELECT 1 FROM j5_playbook_staffing_launch used
      WHERE used.run_id = run.run_id AND used.step_id = ${request.stepId} AND used.persona_id = ${request.personaId})`;

export const approvedStaffingPick = Effect.fn("Playbooks.approvedStaffingPick")(function* (
  request: StaffingRequest,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    persona_picks_json: string;
  }>`SELECT checkpoint.persona_picks_json ${activeApproval(sql, request)}`;
  if (!row) return undefined;
  const picks = yield* decodePickScopes(row.persona_picks_json);
  return Object.hasOwn(picks, request.personaId) ? picks[request.personaId] : undefined;
});

export const spendStaffingPick = Effect.fn("Playbooks.spendStaffingPick")(function* (
  request: StaffingRequest,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`INSERT OR IGNORE INTO j5_playbook_staffing_launch (run_id, step_id, persona_id)
    SELECT run.run_id, ${request.stepId}, ${request.personaId} ${activeApproval(sql, request)}
    RETURNING run_id`;
  return rows.length === 1;
});
