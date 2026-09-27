import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX j5_playbook_status_updated ON j5_playbook_run(status, updated_at)`;
  yield* sql`CREATE INDEX j5_playbook_active_updated
    ON j5_playbook_run((status = 'active'), updated_at)`;
  yield* sql`CREATE INDEX j5_playbook_request_run ON j5_playbook_request(run_id)`;
  // Terminal runs cannot move again. Keep start and finish retries, which must remain idempotent.
  yield* sql`DELETE FROM j5_playbook_request
    WHERE run_id IN (SELECT run_id FROM j5_playbook_run WHERE status <> 'active')
      AND json_extract(request_json, '$[0]') NOT IN ('start', 'complete', 'cancel')`;
  yield* sql`CREATE TRIGGER j5_playbook_prune_requests AFTER UPDATE OF status ON j5_playbook_run
    WHEN OLD.status = 'active' AND NEW.status <> 'active'
    BEGIN
      DELETE FROM j5_playbook_request WHERE run_id = NEW.run_id
        AND json_extract(request_json, '$[0]') NOT IN ('start', 'complete', 'cancel');
    END`;
});
