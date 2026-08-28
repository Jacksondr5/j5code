import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  ControlledParentSeedAfterWritesError,
  type ControlledParentSeedInput,
  runControlledParentSeed,
} from "./ControlledParentSeed.ts";
import { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const createdAt = "2026-08-28T12:00:00.000Z";

const makeInput = (baseDir: string): ControlledParentSeedInput => ({
  baseDir,
  squadron: {
    id: SquadronId.make("squadron:controlled-parent"),
    name: "Controlled parent's squadron",
    createdAt,
  },
  participantId: ParticipantId.make("agent:j5:a2a:controlled-parent"),
  threadId: ThreadId.make("thread:controlled-parent"),
  homeCommandId: CommCommandId.make("command:j5:a2a:controlled-parent:home"),
  placementCommandId: PlacementCommandId.make("command:j5:a2a:controlled-parent:placement"),
  placementRequestFingerprint: "controlled-parent-seed-v1",
});

const createDatabase = Effect.fn("createControlledParentSeedDatabase")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = path.join(baseDir, "userdata", "state.sqlite");
  yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
  yield* runJ5A2AMigrations().pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
  );
  return databasePath;
});

const readSeedCounts = Effect.fn("readControlledParentSeedCounts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly squadrons: number;
    readonly home_events: number;
    readonly receipts: number;
    readonly memberships: number;
    readonly placement_events: number;
    readonly placements: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM j5_a2a_squadron) AS squadrons,
      (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'participant.joined') AS home_events,
      (SELECT COUNT(*) FROM j5_a2a_comm_command_receipt) AS receipts,
      (SELECT COUNT(*) FROM j5_a2a_squadron_membership) AS memberships,
      (SELECT COUNT(*) FROM j5_a2a_placement_event) AS placement_events,
      (SELECT COUNT(*) FROM j5_a2a_participant_placement) AS placements
  `;
  return rows[0]!;
});

it.layer(NodeServices.layer)("controlled parent seed", (it) => {
  it.effect("commits the complete fixed parent setup through the explicit base directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-controlled-parent-seed-" });
      const databasePath = yield* createDatabase(baseDir);
      const input = makeInput(baseDir);

      const result = yield* runControlledParentSeed(input);
      assert.equal(result.database, databasePath);
      assert.equal((yield* fs.stat(result.backup)).mode & 0o777, 0o600);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* readSeedCounts(), {
          squadrons: 1,
          home_events: 1,
          receipts: 1,
          memberships: 1,
          placement_events: 1,
          placements: 1,
        });
        assert.deepStrictEqual(
          yield* sql<{
            readonly squadron_name: string;
            readonly event_command_id: string;
            readonly event_participant_id: string;
            readonly event_thread_id: string;
            readonly receipt_command_type: string;
            readonly receipt_result_seq: number;
            readonly membership_thread_id: string;
            readonly placement_command_id: string;
            readonly placement_request_fingerprint: string;
            readonly placement_actor: string;
            readonly provenance_kind: string;
            readonly placement_parent_id: string | null;
          }>`
            SELECT
              squadron.name AS squadron_name,
              event.command_id AS event_command_id,
              json_extract(event.payload, '$.participant.id') AS event_participant_id,
              json_extract(event.payload, '$.participant.threadId') AS event_thread_id,
              receipt.command_type AS receipt_command_type,
              receipt.result_seq AS receipt_result_seq,
              membership.thread_id AS membership_thread_id,
              placement_event.command_id AS placement_command_id,
              placement_event.request_fingerprint AS placement_request_fingerprint,
              placement_event.actor AS placement_actor,
              placement.provenance_kind AS provenance_kind,
              placement.placement_parent_id AS placement_parent_id
            FROM j5_a2a_comm_event AS event
            JOIN j5_a2a_squadron AS squadron
              ON squadron.id = event.squadron_id
            JOIN j5_a2a_comm_command_receipt AS receipt
              ON receipt.command_id = event.command_id
            JOIN j5_a2a_squadron_membership AS membership
              ON membership.squadron_id = event.squadron_id
             AND membership.participant_id = ${input.participantId}
            JOIN j5_a2a_placement_event AS placement_event
              ON placement_event.squadron_id = event.squadron_id
             AND placement_event.participant_id = ${input.participantId}
            JOIN j5_a2a_participant_placement AS placement
              ON placement.squadron_id = event.squadron_id
             AND placement.participant_id = ${input.participantId}
          `,
          [
            {
              squadron_name: input.squadron.name,
              event_command_id: input.homeCommandId,
              event_participant_id: input.participantId,
              event_thread_id: input.threadId,
              receipt_command_type: "comm.append",
              receipt_result_seq: 1,
              membership_thread_id: input.threadId,
              placement_command_id: input.placementCommandId,
              placement_request_fingerprint: input.placementRequestFingerprint,
              placement_actor: "platform",
              provenance_kind: "unknown",
              placement_parent_id: null,
            },
          ],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

      assert.equal(path.dirname(result.database), path.join(baseDir, "userdata"));
    }),
  );

  it.effect("rolls back every row when validation fails after the final write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "j5-controlled-parent-rollback-",
      });
      const databasePath = yield* createDatabase(baseDir);
      let observedCompleteSeed = false;
      const afterWrites = Effect.gen(function* () {
        assert.deepStrictEqual(yield* readSeedCounts(), {
          squadrons: 1,
          home_events: 1,
          receipts: 1,
          memberships: 1,
          placement_events: 1,
          placements: 1,
        });
        observedCompleteSeed = true;
        return yield* new ControlledParentSeedAfterWritesError({
          reason: "forced failure after final controlled-parent write",
        });
      });

      const error = yield* runControlledParentSeed(makeInput(baseDir), { afterWrites }).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ControlledParentSeedDatabaseError");
      assert.isTrue(observedCompleteSeed);

      yield* Effect.gen(function* () {
        assert.deepStrictEqual(yield* readSeedCounts(), {
          squadrons: 0,
          home_events: 0,
          receipts: 0,
          memberships: 0,
          placement_events: 0,
          placements: 0,
        });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
    }),
  );
});
