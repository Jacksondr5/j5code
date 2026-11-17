import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN holder_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN holder_thread_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_run ADD COLUMN assigned_by_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_step_delivery ADD COLUMN target_participant_id TEXT`;
  yield* sql`ALTER TABLE j5_playbook_step_delivery ADD COLUMN assigned_by_participant_id TEXT`;

  yield* sql`UPDATE j5_playbook_run AS run SET assigned_by_participant_id = COALESCE(
    (SELECT captain_participant_id FROM j5_agent_crew_instance
      WHERE id = run.crew_instance_id AND captain_thread_id = run.owner_thread_id),
    (SELECT MIN(participant_id) FROM j5_a2a_membership
      WHERE thread_id = run.owner_thread_id AND participant_kind = 'agent'
      HAVING COUNT(DISTINCT participant_id) = 1)
  ) WHERE definition_json IS NOT NULL`;

  // A recorded thread remains the target even when its seat now belongs to another worker.
  yield* sql`UPDATE j5_playbook_step_delivery AS landing SET
    assigned_by_participant_id = (SELECT assigned_by_participant_id FROM j5_playbook_run WHERE run_id = landing.run_id),
    target_participant_id = COALESCE(
      (SELECT MIN(participant_id) FROM j5_a2a_membership
        WHERE thread_id = landing.target_thread_id AND participant_kind = 'agent'
        HAVING COUNT(DISTINCT participant_id) = 1),
      (SELECT member.participant_id FROM j5_agent_crew_member member
        JOIN j5_playbook_run run ON run.crew_instance_id = member.crew_instance_id
        WHERE run.run_id = landing.run_id AND member.thread_id = landing.target_thread_id
          AND member.seat_name = landing.target_seat),
      (SELECT assigned_by_participant_id FROM j5_playbook_run
        WHERE run_id = landing.run_id AND owner_thread_id = landing.target_thread_id)
    ) WHERE EXISTS (SELECT 1 FROM j5_playbook_run run
      WHERE run.run_id = landing.run_id AND run.definition_json IS NOT NULL)`;

  yield* sql`UPDATE j5_playbook_run AS run SET holder_thread_id = CASE
    WHEN EXISTS (SELECT 1 FROM j5_playbook_step_delivery
      WHERE run_id = run.run_id AND step_id = run.current_step_id)
    THEN (SELECT target_thread_id FROM j5_playbook_step_delivery
      WHERE run_id = run.run_id AND step_id = run.current_step_id
      ORDER BY landed_at DESC, rowid DESC LIMIT 1)
    ELSE owner_thread_id END
    WHERE definition_json IS NOT NULL`;
  yield* sql`UPDATE j5_playbook_run AS run SET holder_participant_id = COALESCE(
    (SELECT target_participant_id FROM j5_playbook_step_delivery
      WHERE run_id = run.run_id AND step_id = run.current_step_id
      ORDER BY landed_at DESC, rowid DESC LIMIT 1),
    CASE WHEN holder_thread_id = owner_thread_id THEN assigned_by_participant_id END
  ) WHERE definition_json IS NOT NULL`;
});
