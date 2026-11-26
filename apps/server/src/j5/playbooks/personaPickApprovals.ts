import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { readPlaybookRequest } from "./PlaybookRequests.ts";

const PersonaIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodePersonaIds = Schema.decodeUnknownEffect(PersonaIds);

// A person approved the named personas for this owner and this active run.
export const approvedPlaybookPersonaPicks = Effect.fn("Playbooks.approvedPersonaPicks")(function* (
  owner: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ persona_request_id: string; persona_picks_json: string }>`
    SELECT run.persona_request_id, run.persona_picks_json FROM j5_playbook_run run
    WHERE run.owner_thread_id = ${owner} AND run.status = 'active'
      AND run.persona_request_id IS NOT NULL`;
  if (!row || (yield* readPlaybookRequest(sql, row.persona_request_id))?.status !== "approved")
    return new Set<string>();
  const [live] = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
    WHERE thread_id = ${owner} AND archived_at IS NULL AND deleted_at IS NULL`;
  return new Set(live ? yield* decodePersonaIds(row.persona_picks_json) : []);
});
