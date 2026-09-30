import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A Crew can follow a playbook. The proposal records it and the instance copies it at approval;
 * the definition path is its identity and the name is for display. A member records the step ids
 * it owns as a JSON array. Existing rows read as following no playbook and owning no steps.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN playbook_name TEXT`;
  yield* sql`ALTER TABLE j5_agent_crew_proposal ADD COLUMN playbook_definition_path TEXT`;
  yield* sql`ALTER TABLE j5_agent_crew_instance ADD COLUMN playbook_name TEXT`;
  yield* sql`ALTER TABLE j5_agent_crew_instance ADD COLUMN playbook_definition_path TEXT`;
  yield* sql`ALTER TABLE j5_agent_crew_member ADD COLUMN playbook_step_ids TEXT`;
});
