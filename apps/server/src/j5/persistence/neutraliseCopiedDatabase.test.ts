import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrateDevDb } from "../../../scripts/migrate-dev-db.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { neutraliseCopiedDatabase, neutraliseJ5State } from "./neutraliseCopiedDatabase.ts";

const at = "2026-08-01T00:00:00.000Z";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/**
 * One of each row a server acts on at start, beside the history that must survive: a peer with
 * its credential, a session that lets it poll, a machine token, a waiting delivery and one handed
 * out to a polling peer, an open agent Exchange, a live Crew with a seat, a launch report still
 * owed, a proposal awaiting the person, and an active playbook run with a step not yet taken.
 */
const seed = Effect.fn("test.j5.neutralise.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* runJ5A2AMigrations();

  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project', 'Project', '/tmp/project', '[]', ${at}, ${at}, NULL)`;
  yield* sql`INSERT INTO j5_a2a_project_ledger (project_id, created_at) VALUES ('project', ${at})`;
  for (const [seq, kind] of [
    [1, "exchange.opened"],
    [2, "message.sent"],
    [3, "message.delivered"],
  ] as const) {
    yield* sql`INSERT INTO j5_a2a_comm_event (seq, project_id, kind, payload, created_at)
      VALUES (${seq}, 'project', ${kind}, '{}', ${at})`;
  }

  yield* sql`INSERT INTO j5_a2a_peer
    (environment_id, label, link_mode, origin, credential, created_at, updated_at)
    VALUES
      ('env-pushed', 'Pushed', 'push', 'https://peer.example', 'peer-secret', ${at}, ${at}),
      ('env-polling', 'Polling', 'store', NULL, NULL, ${at}, ${at})`;
  yield* sql`INSERT INTO j5_a2a_peer_store_grant (session_id, environment_id, issued_at)
    VALUES ('session-peer', 'env-polling', ${at})`;
  for (const [sessionId, subject, scopes] of [
    ["session-peer", "env-polling", '["a2a:peer"]'],
    ["session-machine", "machine:watchdog", '["a2a:send"]'],
    ["session-browser", "one-time-token", '["orchestration:read"]'],
  ] as const) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${sessionId}, ${subject}, ${scopes}, 'bearer-access-token', ${at}, ${at})`;
  }
  yield* sql`INSERT INTO j5_a2a_machine_participant
    (participant_id, project_id, name, joined_seq, created_at)
    VALUES ('machine:watchdog', 'project', 'watchdog', 1, ${at})`;

  for (const [messageId, status, handedOutAt] of [
    ["message-pending", "pending", null],
    ["message-retrying", "retry_scheduled", null],
    ["message-handed-out", "pending", at],
    ["message-delivered", "delivered", null],
    ["message-alarmed", "alarmed", null],
  ] as const) {
    yield* sql`INSERT INTO j5_a2a_delivery
      (project_id, message_id, command_id, sent_seq, sender_id, receiver_id, receiver_project_id,
       exchange_role, correlation_id, message_text, status, next_attempt_at, created_at,
       updated_at, envelope_channel, handed_out_at)
      VALUES ('project', ${messageId}, ${`command-${messageId}`}, 2, 'agent:a', 'agent:b',
        'project', 'none', ${`correlation-${messageId}`}, 'hello', ${status},
        ${status === "retry_scheduled" ? at : null}, ${at}, ${at}, 'peer', ${handedOutAt})`;
  }

  for (const [exchangeId, receiver, status, closedSeq] of [
    ["exchange-open", "agent:b", "open", null],
    ["exchange-human", "human:operator", "open", null],
    ["exchange-closed", "agent:b", "closed", 3],
  ] as const) {
    yield* sql`INSERT INTO j5_a2a_exchange
      (project_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, closed_seq,
       created_at, updated_at)
      VALUES ('project', ${exchangeId}, 'agent:a', ${receiver}, ${status}, 'ask', 1, ${closedSeq},
        ${at}, ${at})`;
  }

  for (const [id, archivedAt] of [
    ["crew-live", null],
    ["crew-retired", at],
  ] as const) {
    yield* sql`INSERT INTO j5_agent_crew_instance
      (id, project_id, captain_participant_id, captain_thread_id, display_name, brief, version,
       created_at, archived_at)
      VALUES (${id}, 'project', 'agent:captain', 'thread-captain', ${id}, 'brief', 1, ${at},
        ${archivedAt})`;
    yield* sql`INSERT INTO j5_agent_crew_member
      (crew_instance_id, seat_name, participant_id, thread_id, ordinal, added_version)
      VALUES (${id}, 'builder', ${`agent:${id}`}, ${`thread-${id}`}, 0, 1)`;
  }
  for (const [id, status, resolvedAt, reportedAt] of [
    ["proposal-unreported", "approved", at, null],
    ["proposal-reported", "approved", at, at],
    ["proposal-open", "open", null, null],
  ] as const) {
    yield* sql`INSERT INTO j5_agent_crew_proposal
      (id, project_id, captain_participant_id, captain_thread_id, kind, status, brief,
       display_name, requested_seats, created_at, resolved_at, reported_at)
      VALUES (${id}, 'project', 'agent:captain', 'thread-captain', 'roster', ${status}, 'brief',
        ${id}, '[]', ${at}, ${resolvedAt}, ${reportedAt})`;
  }

  for (const [runId, status] of [
    ["run-active", "active"],
    ["run-completed", "completed"],
  ] as const) {
    yield* sql`INSERT INTO j5_playbook_run
      (run_id, owner_thread_id, definition_path, current_step_id, status, created_at, updated_at)
      VALUES (${runId}, ${`thread-${runId}`}, 'ship.md', 'build', ${status}, ${at}, ${at})`;
  }
  yield* sql`INSERT INTO j5_playbook_step_delivery (run_id, request_id, step_id, landed_at)
    VALUES ('run-active', 'request-1', 'build', ${at})`;
});

/** Every row a starting server would act on, by the queries its workers run. */
const actingRows = Effect.fn("test.j5.neutralise.actingRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const count = (from: string) =>
    sql
      .unsafe<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${from}`)
      .pipe(Effect.map((rows) => rows[0]?.count ?? 0));
  return {
    peers: yield* count("j5_a2a_peer"),
    peerStoreGrants: yield* count("j5_a2a_peer_store_grant"),
    a2aSessions: yield* count(
      "auth_sessions WHERE subject LIKE 'machine:%' OR scopes LIKE '%a2a:%'",
    ),
    deliveries: yield* count("j5_a2a_delivery WHERE status IN ('pending', 'retry_scheduled')"),
    exchanges: yield* count(
      "j5_a2a_exchange WHERE status = 'open' AND receiver_id NOT LIKE 'human:%'",
    ),
    crews: yield* count("j5_agent_crew_instance WHERE archived_at IS NULL"),
    crewLaunchReports: yield* count(
      "j5_agent_crew_proposal WHERE status = 'approved' AND reported_at IS NULL",
    ),
    crewProposals: yield* count(
      "j5_agent_crew_proposal WHERE status NOT IN ('approved', 'declined')",
    ),
    playbookRuns: yield* count("j5_playbook_run WHERE status = 'active'"),
    playbookStepDeliveries: yield* count("j5_playbook_step_delivery WHERE resolved_at IS NULL"),
  };
});

const nothingActing = {
  peers: 0,
  peerStoreGrants: 0,
  a2aSessions: 0,
  deliveries: 0,
  exchanges: 0,
  crews: 0,
  crewLaunchReports: 0,
  crewProposals: 0,
  playbookRuns: 0,
  playbookStepDeliveries: 0,
};

it.layer(NodeServices.layer)("neutraliseCopiedDatabase", (it) => {
  it.effect("stands down everything a server would act on and keeps the history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();

      const stoodDown = yield* neutraliseJ5State();
      assert.deepEqual(stoodDown, {
        peers: 2,
        peerStoreGrants: 1,
        a2aSessions: 2,
        deliveries: 3,
        exchanges: 1,
        crews: 1,
        crewLaunchReports: 1,
        crewProposals: 1,
        playbookRuns: 1,
        playbookStepDeliveries: 1,
      });
      assert.deepEqual(yield* actingRows(), nothingActing);

      // Stood down into states the product already reads, not removed.
      assert.deepEqual(
        yield* sql`SELECT message_id, status, next_attempt_at FROM j5_a2a_delivery ORDER BY message_id`,
        [
          { message_id: "message-alarmed", status: "alarmed", next_attempt_at: null },
          { message_id: "message-delivered", status: "delivered", next_attempt_at: null },
          { message_id: "message-handed-out", status: "cancelled", next_attempt_at: null },
          { message_id: "message-pending", status: "cancelled", next_attempt_at: null },
          { message_id: "message-retrying", status: "cancelled", next_attempt_at: null },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT exchange_id, status, closed_seq FROM j5_a2a_exchange ORDER BY exchange_id`,
        [
          { exchange_id: "exchange-closed", status: "closed", closed_seq: 3 },
          // The person's inbox still has its open ask.
          { exchange_id: "exchange-human", status: "open", closed_seq: null },
          { exchange_id: "exchange-open", status: "dropped", closed_seq: 3 },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT id, archived_at IS NOT NULL AS retired, retired_with_captain
          FROM j5_agent_crew_instance ORDER BY id`,
        [
          { id: "crew-live", retired: 1, retired_with_captain: 0 },
          { id: "crew-retired", retired: 1, retired_with_captain: 0 },
        ],
      );
      assert.deepEqual(yield* sql`SELECT id, status FROM j5_agent_crew_proposal ORDER BY id`, [
        { id: "proposal-open", status: "declined" },
        { id: "proposal-reported", status: "approved" },
        { id: "proposal-unreported", status: "approved" },
      ]);
      assert.deepEqual(yield* sql`SELECT run_id, status FROM j5_playbook_run ORDER BY run_id`, [
        { run_id: "run-active", status: "cancelled" },
        { run_id: "run-completed", status: "completed" },
      ]);
      assert.deepEqual(yield* sql`SELECT outcome FROM j5_playbook_step_delivery`, [
        { outcome: "skipped" },
      ]);

      // Untouched: the ledger, Crew seats, the machine's registration, and other sessions.
      const [history] = yield* sql<{ events: number; seats: number; machines: number }>`
        SELECT
          (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events,
          (SELECT COUNT(*) FROM j5_agent_crew_member) AS seats,
          (SELECT COUNT(*) FROM j5_a2a_machine_participant) AS machines`;
      assert.deepEqual(history, { events: 3, seats: 2, machines: 1 });
      assert.deepEqual(yield* sql`SELECT session_id FROM auth_sessions`, [
        { session_id: "session-browser" },
      ]);

      // A second pass finds nothing left to do.
      assert.deepEqual(yield* neutraliseJ5State(), nothingActing);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a database that never ran J5's migrations alone", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepEqual(yield* neutraliseJ5State(), nothingActing);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses the database the copy was taken from", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-neutralise-source-" });
      const source = path.join(dir, "statev2.sqlite");
      yield* withDatabase(source, seed());
      // A different spelling of the same file.
      const alias = path.join(dir, "alias.sqlite");
      yield* fs.symlink(source, alias);

      const error = yield* neutraliseCopiedDatabase({ copyPath: alias, sourcePath: source }).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "NeutraliseCopiedDatabaseRefusedError");
      assert.equal(
        error._tag === "NeutraliseCopiedDatabaseRefusedError" && error.reason,
        "is-the-source",
      );
      assert.equal((yield* withDatabase(source, actingRows())).peers, 2);
    }),
  );

  it.effect("refuses a database in an installed T3 or J5 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-neutralise-homes-" });
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        for (const name of [".t3", ".j5code"]) {
          const stateDir = path.join(home, name, "userdata");
          yield* fs.makeDirectory(stateDir, { recursive: true });
          const installed = path.join(stateDir, "statev2.sqlite");
          yield* withDatabase(installed, seed());

          const error = yield* neutraliseCopiedDatabase({
            copyPath: installed,
            sourcePath: path.join(home, "elsewhere.sqlite"),
          }).pipe(Effect.flip);
          assert.equal(
            error._tag === "NeutraliseCopiedDatabaseRefusedError" && error.reason,
            "in-a-shared-home",
          );
          assert.equal((yield* withDatabase(installed, actingRows())).peers, 2);
        }
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
      }
    }),
  );

  it.effect("migrate-dev-db stands J5 state down in the copy and never in its source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-neutralise-shared-" });
      const devDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-neutralise-dev-" });
      const source = path.join(sourceDir, "statev2.sqlite");
      yield* withDatabase(source, seed());
      const before = yield* withDatabase(source, actingRows());

      const result = yield* runMigrateDevDb({
        baseDir: devDir,
        source,
        projects: 5,
        threadsPerProject: 10,
      });

      assert.deepEqual(yield* withDatabase(result.databasePath, actingRows()), nothingActing);
      // The credential is not in the file at all, not merely unlinked from a table.
      assert.isFalse(Buffer.from(yield* fs.readFile(result.databasePath)).includes("peer-secret"));
      const [kept] = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ events: number; exchanges: number }>`
            SELECT
              (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events,
              (SELECT COUNT(*) FROM j5_a2a_exchange) AS exchanges`;
        }),
      );
      assert.deepEqual(kept, { events: 3, exchanges: 3 });
      assert.deepEqual(yield* withDatabase(source, actingRows()), before);
    }),
  );
});
