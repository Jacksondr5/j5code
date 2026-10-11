/**
 * Records `j5.fleet.snapshot` every fifteen minutes: how many threads are working at once, how
 * many of them an agent started, how big the live Crews are, and how many asks are waiting. The
 * boot heartbeat only counts threads and projects, which says nothing about a fleet.
 *
 * Every number is a count read from the projections and J5's own tables; no ids or names.
 *
 * @module FleetSnapshot
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";

const SNAPSHOT_INTERVAL = Duration.minutes(15);

const Snapshot = Schema.Struct({
  openThreads: Schema.Number,
  workingThreads: Schema.Number,
  workingAgentStartedThreads: Schema.Number,
  queuedRuns: Schema.Number,
  liveCrews: Schema.Number,
  largestCrewSeats: Schema.Number,
  openAsksToPerson: Schema.Number,
  openAsksToAgents: Schema.Number,
});
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);

export interface FleetSnapshotShape {
  /** Reads the fleet's current counts and records them. */
  readonly record: Effect.Effect<void>;
}

export class FleetSnapshot extends Context.Service<FleetSnapshot, FleetSnapshotShape>()(
  "t3/j5/analytics/FleetSnapshot",
) {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    FleetSnapshot,
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      const sql = yield* SqlClient.SqlClient;

      const record = Effect.gen(function* () {
        // A run holds its thread from `preparing` until it ends; `queued` waits behind another.
        const rows = yield* sql`
          WITH working AS (
            SELECT DISTINCT run.thread_id
            FROM orchestration_v2_projection_runs AS run
            WHERE run.status IN ('preparing', 'starting', 'running', 'waiting')
          ),
          crew_seats AS (
            SELECT COUNT(*) AS seats
            FROM j5_agent_crew_member AS member
            JOIN j5_agent_crew_instance AS crew ON crew.id = member.crew_instance_id
            WHERE crew.archived_at IS NULL
            GROUP BY member.crew_instance_id
          )
          SELECT
            (
              SELECT COUNT(*) FROM orchestration_v2_projection_threads
              WHERE archived_at IS NULL AND deleted_at IS NULL
            ) AS "openThreads",
            (SELECT COUNT(*) FROM working) AS "workingThreads",
            (
              SELECT COUNT(*)
              FROM working
              JOIN orchestration_v2_projection_threads AS thread
                ON thread.thread_id = working.thread_id
              WHERE json_extract(thread.payload_json, '$.createdBy') = 'agent'
            ) AS "workingAgentStartedThreads",
            (
              SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status = 'queued'
            ) AS "queuedRuns",
            (
              SELECT COUNT(*) FROM j5_agent_crew_instance WHERE archived_at IS NULL
            ) AS "liveCrews",
            (SELECT COALESCE(MAX(seats), 0) FROM crew_seats) AS "largestCrewSeats",
            (
              SELECT COUNT(*) FROM j5_a2a_exchange
              WHERE status = 'open' AND receiver_id LIKE 'human:%'
            ) AS "openAsksToPerson",
            (
              SELECT COUNT(*) FROM j5_a2a_exchange
              WHERE status = 'open' AND receiver_id NOT LIKE 'human:%'
            ) AS "openAsksToAgents"
        `;
        yield* analytics.record("j5.fleet.snapshot", yield* decodeSnapshot(rows[0]));
      }).pipe(
        Effect.withSpan("j5.analytics.fleetSnapshot"),
        Effect.catchCause((cause) => Effect.logWarning("J5 fleet snapshot skipped", { cause })),
      );

      if (daemon)
        yield* Effect.sleep(SNAPSHOT_INTERVAL).pipe(
          Effect.andThen(record),
          Effect.forever,
          Effect.forkScoped,
        );

      return FleetSnapshot.of({ record });
    }),
  );

/** For tests, which take the snapshot themselves. */
export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
