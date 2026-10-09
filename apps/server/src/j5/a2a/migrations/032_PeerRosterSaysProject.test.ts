import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PeerRosterAgent } from "@t3tools/contracts/j5";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";

const AT = "2026-10-08T00:00:00.000Z";
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRoster = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PeerRosterAgent)),
);

it.effect("renames the fields of a stored peer roster, keeping its agents and their order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runJ5A2AMigrations({ toMigrationInclusive: 31 });
    // What a polling peer on protocol 1 sent, as the storing server kept it.
    const stored = ["ios-build", "ios-test"].map((name) => ({
      participantId: `agent:j5:a2a:thread:${name}`,
      squadronId: "squadron:laptop",
      squadronName: "iOS",
      threadId: `thread:${name}`,
      displayName: name,
      archived: false,
      canReceiveMessage: true,
    }));
    const insertPeer = (environmentId: string, roster: string | null) => sql`
      INSERT INTO j5_a2a_peer (
        environment_id, label, link_mode, roster_json, roster_hash, created_at, updated_at
      ) VALUES (${environmentId}, ${environmentId}, 'store', ${roster}, ${roster && "hash-1"}, ${AT}, ${AT})
    `;
    yield* insertPeer("environment:laptop", encodeStored(stored));
    yield* insertPeer("environment:never-polled", null);

    yield* runJ5A2AMigrations();

    const rows = yield* sql<{
      readonly environment_id: string;
      readonly roster_json: string | null;
      readonly roster_hash: string | null;
    }>`SELECT environment_id, roster_json, roster_hash FROM j5_a2a_peer ORDER BY environment_id`;
    assert.deepStrictEqual(yield* decodeRoster(rows[0]?.roster_json), [
      {
        participantId: "agent:j5:a2a:thread:ios-build",
        projectId: "squadron:laptop",
        projectTitle: "iOS",
        threadId: ThreadId.make("thread:ios-build"),
        displayName: "ios-build",
        archived: false,
        canReceiveMessage: true,
      },
      {
        participantId: "agent:j5:a2a:thread:ios-test",
        projectId: "squadron:laptop",
        projectTitle: "iOS",
        threadId: ThreadId.make("thread:ios-test"),
        displayName: "ios-test",
        archived: false,
        canReceiveMessage: true,
      },
    ]);
    assert.notInclude(rows[0]?.roster_json ?? "", 'squadron"');
    // The hash is untouched, so the poller is not asked for a roster it already sent.
    assert.strictEqual(rows[0]?.roster_hash, "hash-1");
    assert.deepStrictEqual(rows[1], {
      environment_id: "environment:never-polled",
      roster_json: null,
      roster_hash: null,
    });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
