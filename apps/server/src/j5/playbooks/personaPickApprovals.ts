import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const PickDigests = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
export const encodePickDigests = Schema.encodeSync(PickDigests);
const decodePickDigests = Schema.decodeUnknownEffect(PickDigests);

// A person approved the displayed definition for this owner and this active run.
export const approvedPlaybookPersonaPicks = Effect.fn("Playbooks.approvedPersonaPicks")(function* (
  owner: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ persona_picks_json: string }>`
    SELECT checkpoint.persona_picks_json
    FROM j5_playbook_run run
    JOIN j5_playbook_checkpoint checkpoint ON checkpoint.run_id = run.run_id
    WHERE run.owner_thread_id = ${owner} AND run.status = 'active'
      AND checkpoint.status = 'approved' AND checkpoint.persona_picks_json IS NOT NULL
    LIMIT 1`;
  if (!rows[0]) return new Map<string, string>();
  const live = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
    WHERE thread_id = ${owner} AND archived_at IS NULL AND deleted_at IS NULL`;
  return new Map(
    Object.entries(live.length === 0 ? {} : yield* decodePickDigests(rows[0].persona_picks_json)),
  );
});
