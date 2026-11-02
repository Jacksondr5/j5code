import { assert, it } from "@effect/vitest";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as PersonAccess from "./PersonAccess.ts";
import {
  OTHER_PROJECT,
  PROJECT,
  accessLayer,
  person,
  placed,
  thread,
} from "./test-support/accessHarness.ts";

const sessionOf = (id: string, subject = "one-time-token") => ({
  sessionId: AuthSessionId.make(id),
  subject,
});

it.layer(accessLayer)("PersonAccess", (it) => {
  it.effect(
    "tells a person's device, the first owner's, a service's and an unknown one apart",
    () =>
      Effect.gen(function* () {
        const people = yield* PersonAccess.PersonAccess;
        const priya = yield* person("Priya", [{ scope: { kind: "server" }, level: "viewer" }]);
        yield* people.bindSession({
          sessionId: AuthSessionId.make("session:priya"),
          personId: priya.personId,
          ceiling: ["orchestration:read"],
        });

        const bound = yield* people.sessionReach(sessionOf("session:priya"));
        assert.strictEqual(bound.kind, "person");
        if (bound.kind === "person") {
          assert.strictEqual(bound.person.personId, priya.personId);
          assert.strictEqual(bound.serverLevel, "viewer");
          assert.deepStrictEqual(bound.ceiling, ["orchestration:read"]);
          // A server-scope Viewer is narrowed all the same: Viewers never see files (AC24).
          assert.isFalse(PersonAccess.isWide(bound));
        }

        // The startup link's and the desktop app's sessions are the first owner's (AC2).
        // T3 Connect's included: upstream mints it only for the server's linked cloud account.
        for (const subject of ["administrative-bootstrap", "desktop-bootstrap", "cloud-connect"]) {
          const reach = yield* people.sessionReach(sessionOf(`session:${subject}`, subject));
          assert.strictEqual(reach.kind, "person");
          if (reach.kind === "person") {
            assert.isTrue(reach.person.firstOwner);
            assert.strictEqual(reach.serverLevel, "owner");
            assert.isTrue(PersonAccess.isWide(reach));
          }
        }

        for (const subject of ["peer:environment-1", "mcp-client", "cli-issued-session"]) {
          const reach = yield* people.sessionReach(sessionOf(`session:${subject}`, subject));
          assert.strictEqual(reach.kind, "service");
        }

        // A Connections link made before its creator was recorded is no one's.
        const unknown = yield* people.sessionReach(sessionOf("session:link", "one-time-token"));
        assert.strictEqual(unknown.kind, "unknown");
        assert.isFalse(PersonAccess.isWide(unknown));
      }),
  );

  it.effect("takes the highest level over a thread from the server, its project and above it", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const captain = yield* thread("thread:captain");
      const seat = yield* thread("thread:seat", OTHER_PROJECT);
      const subagent = yield* thread("thread:subagent", PROJECT, {
        parent: "thread:captain",
        relationship: "subagent",
      });
      const fork = yield* thread("thread:fork", PROJECT, {
        parent: "thread:captain",
        relationship: "fork",
      });
      yield* placed("thread:captain", null);
      yield* placed("thread:seat", "thread:captain");
      const other = yield* thread("thread:other");

      const sam = yield* person("Sam", [
        { scope: { kind: "thread", threadId: captain }, level: "collaborator" },
        { scope: { kind: "project", projectId: PROJECT }, level: "viewer" },
      ]);
      // The thread and the agents beneath it, in any project; not a fork (AC9).
      assert.strictEqual(yield* people.threadLevel(sam.personId, captain), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, subagent), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, seat), "collaborator");
      assert.strictEqual(yield* people.threadLevel(sam.personId, fork), "viewer");
      // Elsewhere in the project, the project's level (AC10, AC11).
      assert.strictEqual(yield* people.threadLevel(sam.personId, other), "viewer");
      assert.strictEqual(yield* people.projectLevel(sam.personId, PROJECT), "viewer");
      assert.strictEqual(yield* people.projectLevel(sam.personId, OTHER_PROJECT), null);
      // The seat's project is in the sidebar for the seat's sake, though its level is not held.
      assert.isTrue(yield* people.projectInFeed(sam.personId, OTHER_PROJECT));

      const maria = yield* person("Maria", [{ scope: { kind: "server" }, level: "owner" }]);
      assert.strictEqual(yield* people.threadLevel(maria.personId, seat), "owner");

      const reaching = yield* people.scopePeople({ kind: "thread", threadId: seat });
      const sams = reaching.find((entry) => entry.person.personId === sam.personId);
      assert.deepStrictEqual(sams?.via, [
        { via: "ancestor", level: "collaborator", scope: { kind: "thread", threadId: captain } },
      ]);
      assert.isTrue(reaching.some((entry) => entry.person.personId === maria.personId));
    }),
  );

  it.effect("lists the threads a person reaches as threadLevel reads each one", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const lead = yield* thread("thread:reach-lead");
      yield* thread("thread:reach-subagent", PROJECT, {
        parent: "thread:reach-lead",
        relationship: "subagent",
      });
      yield* thread("thread:reach-fork", PROJECT, {
        parent: "thread:reach-lead",
        relationship: "fork",
      });
      yield* thread("thread:reach-seat", OTHER_PROJECT);
      yield* thread("thread:reach-seat-child", OTHER_PROJECT);
      yield* thread("thread:reach-forked-seat", OTHER_PROJECT);
      yield* thread("thread:reach-elsewhere", OTHER_PROJECT);
      yield* placed("thread:reach-lead", null);
      yield* placed("thread:reach-seat", "thread:reach-lead");
      yield* placed("thread:reach-seat-child", "thread:reach-seat");
      yield* placed("thread:reach-forked-seat", "thread:reach-lead", "forked-from");
      const elsewhere = ThreadId.make("thread:reach-elsewhere");

      const onThread = yield* person("Reach Thread", [
        { scope: { kind: "thread", threadId: lead }, level: "viewer" },
      ]);
      const onBoth = yield* person("Reach Both", [
        { scope: { kind: "thread", threadId: elsewhere }, level: "collaborator" },
        { scope: { kind: "project", projectId: PROJECT }, level: "viewer" },
      ]);
      const nobody = yield* person("Reach Nobody");
      const all = (yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
      `).map((row) => ThreadId.make(row.thread_id));
      for (const someone of [onThread, onBoth, nobody]) {
        const reached = new Set(yield* people.reachableThreads(someone.personId) ?? []);
        for (const id of all) {
          const level = yield* people.threadLevel(someone.personId, id);
          assert.strictEqual(reached.has(id), level !== null, `${someone.displayName}: ${id}`);
        }
      }
      // The lead, its subagent and the seats beneath it, in another project; not a fork.
      assert.sameMembers(
        [...((yield* people.reachableThreads(onThread.personId)) ?? [])],
        [
          "thread:reach-lead",
          "thread:reach-subagent",
          "thread:reach-seat",
          "thread:reach-seat-child",
        ],
      );
      assert.deepStrictEqual(yield* people.reachableThreads(nobody.personId), []);

      // A level at server scope covers every thread; taking a share away takes its threads.
      const everyone = yield* person("Reach Server", [
        { scope: { kind: "server" }, level: "viewer" },
      ]);
      assert.isNull(yield* people.reachableThreads(everyone.personId));
      yield* people.removeLevel({
        personId: onThread.personId,
        scope: { kind: "thread", threadId: lead },
      });
      assert.deepStrictEqual(yield* people.reachableThreads(onThread.personId), []);
    }),
  );

  it.effect("finds a page a tool published by the turn item that names it", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const published = yield* thread("thread:published");
      yield* thread("thread:unpublished");
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'item:render', ${published}, 1, 'tool_call', 'completed', '2026-10-18T00:00:00.000Z',
          '{"toolName":"html_render","output":{"attachmentId":"attachment-page-0001"}}'
        )
      `;
      const reader = yield* person("Page reader", [
        { scope: { kind: "thread", threadId: published }, level: "viewer" },
      ]);
      const outsider = yield* person("Page outsider", [
        {
          scope: { kind: "thread", threadId: ThreadId.make("thread:unpublished") },
          level: "viewer",
        },
      ]);
      const page = { kind: "attachment" as const, attachmentId: "attachment-page-0001" };
      assert.strictEqual(yield* people.messageAssetLevel(reader.personId, page), "viewer");
      assert.strictEqual(yield* people.messageAssetLevel(outsider.personId, page), null);
    }),
  );

  it.effect("keeps Owner at server scope and the first owner where they are", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const owner = yield* people.firstOwner;
      const lowered = yield* people
        .setLevel({ personId: owner.personId, scope: { kind: "server" }, level: "viewer" })
        .pipe(Effect.flip);
      assert.strictEqual(lowered._tag, "FirstOwnerFixedError");
      const removed = yield* people.removePerson(owner.personId).pipe(Effect.flip);
      assert.strictEqual(removed._tag, "FirstOwnerFixedError");

      const sam = yield* person("Sam B");
      const onProject = yield* people
        .setLevel({
          personId: sam.personId,
          scope: { kind: "project", projectId: PROJECT },
          level: "owner",
        })
        .pipe(Effect.flip);
      assert.strictEqual(onProject._tag, "OwnerOutsideServerError");
    }),
  );

  it.effect("removes what a person holds and keeps their record, freeing their name", () =>
    Effect.gen(function* () {
      const people = yield* PersonAccess.PersonAccess;
      const sql = yield* SqlClient.SqlClient;
      const contractor = yield* person("Contractor", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      yield* people.bindSession({
        sessionId: AuthSessionId.make("session:contractor"),
        personId: contractor.personId,
        ceiling: null,
      });

      const ended = yield* people.removePerson(contractor.personId);
      assert.deepStrictEqual(ended, [AuthSessionId.make("session:contractor")]);
      assert.isNull(yield* people.readPerson(contractor.personId));
      assert.strictEqual(
        (yield* people.sessionReach(sessionOf("session:contractor"))).kind,
        "unknown",
      );
      // Their messages keep the name they had (AC47); someone else may now take it (AC44).
      assert.deepStrictEqual(
        yield* sql`SELECT display_name FROM j5_a2a_human_person WHERE person_id = ${contractor.personId}`,
        [{ display_name: "Contractor" }],
      );
      yield* person("contractor");
      const taken = yield* person(" CONTRACTOR ").pipe(Effect.flip);
      assert.strictEqual(taken._tag, "PersonNameTakenError");
    }),
  );
});
