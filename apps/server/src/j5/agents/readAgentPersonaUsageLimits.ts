import {
  usageLimitBlockedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  ProviderInstanceId,
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { AgentPersonaLibraryError } from "./agentPersonaLibrary.ts";

export const readAgentPersonaLimitedInstances = Effect.fn("AgentPersonaUsageLimits.read")(
  function* (now: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly instance_id: string }>`
      WITH successful_work AS MATERIALIZED (
        SELECT succeeded.provider_instance_id AS instance_id,
          MAX(COALESCE(json_extract(succeeded.payload_json, '$.workStartedAt'), json_extract(succeeded.payload_json, '$.startedAt'), succeeded.requested_at)) AS started_at
        FROM orchestration_v2_projection_runs succeeded
        JOIN orchestration_v2_projection_threads owner ON owner.thread_id = succeeded.thread_id
        WHERE owner.deleted_at IS NULL AND succeeded.status = 'completed'
        GROUP BY succeeded.provider_instance_id
      )
      SELECT DISTINCT t.provider_instance_id AS instance_id
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_runs r ON r.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = t.thread_id AND latest.status <> 'queued'
          AND NOT (latest.status = 'cancelled' AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
        ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC, latest.ordinal DESC, latest.run_id DESC LIMIT 1
      ) AND r.status = 'failed'
      JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
        SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
        WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
          AND error.type = 'error' AND error.status = 'failed'
          AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
        ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC LIMIT 1
      )
      WHERE t.deleted_at IS NULL AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        AND t.provider_instance_id = r.provider_instance_id
        AND t.thread_id IN (
          SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
          WHERE failure.type = 'error' AND failure.status = 'failed'
            AND json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'
        )
        AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
        AND (json_extract(item.payload_json, '$.failure.resetAt') IS NULL
          OR julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(DateTime.makeUnsafe(now))}))
        AND NOT EXISTS (
          SELECT 1 FROM successful_work succeeded
          WHERE succeeded.instance_id = t.provider_instance_id
            AND succeeded.started_at > r.completed_at
        )
    `.pipe(
      Effect.mapError(
        (cause) =>
          new AgentPersonaLibraryError({
            message: "Cannot read provider usage-limit state.",
            cause,
          }),
      ),
    );
    return new Set(rows.map(({ instance_id }) => ProviderInstanceId.make(instance_id)));
  },
);

export function limitedPersonaInstancesFromProjections(
  projections: ReadonlyArray<OrchestrationV2ThreadProjection>,
  now: number,
): ReadonlySet<ProviderInstanceId> {
  const active = projections.filter(
    ({ thread }) => thread.deletedAt === null && thread.archivedAt === null,
  );
  const succeeded = new Map<ProviderInstanceId, number>();
  for (const projection of projections.filter(({ thread }) => thread.deletedAt === null)) {
    for (const run of projection.runs) {
      if (run.status !== "completed" || run.completedAt === null) continue;
      succeeded.set(
        run.providerInstanceId,
        Math.max(
          succeeded.get(run.providerInstanceId) ?? -Infinity,
          DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run)),
        ),
      );
    }
  }
  const limited = new Set<ProviderInstanceId>();
  for (const projection of active) {
    const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
    if (run === null || run.providerInstanceId !== projection.thread.providerInstanceId) continue;
    const reset = latestRootProviderFailure(run, projection.turnItems)?.resetAt;
    if (reset != null && Date.parse(reset) <= now) continue;
    if (
      run.completedAt !== null &&
      (succeeded.get(run.providerInstanceId) ?? -Infinity) > DateTime.toEpochMillis(run.completedAt)
    )
      continue;
    limited.add(run.providerInstanceId);
  }
  return limited;
}
