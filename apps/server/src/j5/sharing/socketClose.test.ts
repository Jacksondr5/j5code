import { assert, it } from "@effect/vitest";
import type { AuthSessionId } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as Access from "./Access.ts";
import * as Links from "./Links.ts";
import * as People from "./People.ts";
import * as PersonAccess from "./PersonAccess.ts";
import {
  device,
  isLive,
  person,
  PROJECT,
  recordsLayer,
  thread,
} from "./test-support/accessHarness.ts";

/** Each session upstream revoked, and whether a J5 transaction was open around the revoke. */
const revokes: Array<{ readonly sessionId: AuthSessionId; readonly inTransaction: boolean }> = [];
/** Sessions whose revoke fails, as a failed write would. */
const failing = new Set<AuthSessionId>();

// Upstream publishes a revoke as it writes it, and an open socket's loop reads committed rows
// (writes run on their own worker since v0.1.11), so a revoke inside a J5 transaction can leave
// the socket open for good. J5 must revoke only outside its transactions.
const recordingSessions = Layer.effect(
  SessionStore.SessionStore,
  Effect.gen(function* () {
    const real = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    return SessionStore.SessionStore.of({
      ...real,
      revoke: (sessionId) =>
        Effect.serviceOption(sql.transactionService).pipe(
          Effect.tap((transaction) =>
            Effect.sync(() =>
              revokes.push({ sessionId, inTransaction: Option.isSome(transaction) }),
            ),
          ),
          Effect.andThen(
            failing.has(sessionId)
              ? Effect.fail(
                  new SessionStore.SessionRevocationError({ sessionId, cause: "write failed" }),
                )
              : real.revoke(sessionId),
          ),
        ),
    });
  }),
);

const layer = People.layer.pipe(
  Layer.provideMerge(Links.layer),
  Layer.provideMerge(Access.layer),
  Layer.provide(recordingSessions),
  Layer.provideMerge(recordsLayer),
);

const inTransaction = (sessionId: AuthSessionId) =>
  revokes.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.inTransaction);

it.layer(layer)("J5 ends a device's session outside its own transaction", (it) => {
  it.effect("when its person's level changes", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const lowered = yield* person("Lowered", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      const laptop = yield* device(lowered.personId, LEVEL_PERMISSIONS.collaborator);

      yield* access.setLevel({
        personId: lowered.personId,
        scope: { kind: "server" },
        level: "viewer",
      });
      assert.deepStrictEqual(inTransaction(laptop.sessionId), [false]);
    }),
  );

  it.effect("when the device is claimed", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const unplaced = yield* device(null, LEVEL_PERMISSIONS.collaborator);

      yield* access.claimDevice(
        { ...unplaced.identity, scopes: LEVEL_PERMISSIONS.collaborator },
        { kind: "new", displayName: "Claimed" },
      );
      assert.deepStrictEqual(inTransaction(unplaced.sessionId), [false]);
    }),
  );

  it.effect("when the server starts and it holds more than its level", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const viewer = yield* person("Outdated", [{ scope: { kind: "server" }, level: "viewer" }]);
      const old = yield* device(viewer.personId, LEVEL_PERMISSIONS.collaborator);

      yield* access.renewOutdatedDevices;
      assert.deepStrictEqual(inTransaction(old.sessionId), [false]);
    }),
  );

  it.effect("when its person is removed", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const removed = yield* person("Removed", [{ scope: { kind: "server" }, level: "viewer" }]);
      const tablet = yield* device(removed.personId, LEVEL_PERMISSIONS.viewer);

      yield* access.removePerson(removed.personId);
      assert.deepStrictEqual(inTransaction(tablet.sessionId), [false]);
    }),
  );

  it.effect("when an Owner ends the device", () =>
    Effect.gen(function* () {
      const people = yield* People.People;
      const ended = yield* person("Ended", [{ scope: { kind: "server" }, level: "viewer" }]);
      const phone = yield* device(ended.personId, LEVEL_PERMISSIONS.viewer);

      yield* people.revokeDevice(phone.sessionId);
      assert.deepStrictEqual(inTransaction(phone.sessionId), [false]);
    }),
  );
});

it.layer(layer)("a revoke upstream fails after J5's change commits", (it) => {
  it.effect("still ends the person's other devices, and names the one left live", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const two = yield* person("Two devices", [
        { scope: { kind: "server" }, level: "collaborator" },
      ]);
      const stuck = yield* device(two.personId, LEVEL_PERMISSIONS.collaborator);
      const other = yield* device(two.personId, LEVEL_PERMISSIONS.collaborator);
      failing.add(stuck.sessionId);

      const error = yield* access
        .setLevel({ personId: two.personId, scope: { kind: "server" }, level: "viewer" })
        .pipe(Effect.flip);
      failing.delete(stuck.sessionId);
      assert.strictEqual(error._tag, "AccessRenewalError");
      if (error._tag === "AccessRenewalError") {
        assert.isTrue(error.saved);
        assert.strictEqual(error.sessionId, stuck.sessionId);
      }
      assert.isTrue(yield* isLive(stuck.sessionId));
      assert.isFalse(yield* isLive(other.sessionId));
    }),
  );

  it.effect(
    "ends the device left live at the person's next change, though it narrows nothing",
    () =>
      Effect.gen(function* () {
        const access = yield* Access.Access;
        const narrowed = yield* person("Narrowed", [
          { scope: { kind: "server" }, level: "collaborator" },
        ]);
        const laptop = yield* device(narrowed.personId, LEVEL_PERMISSIONS.collaborator);
        failing.add(laptop.sessionId);
        // Server Collaborator to project Collaborator: the same permissions, a narrower reach.
        yield* access
          .setLevel({
            personId: narrowed.personId,
            scope: { kind: "project", projectId: PROJECT },
            level: "collaborator",
          })
          .pipe(
            Effect.andThen(
              access.removeLevel({ personId: narrowed.personId, scope: { kind: "server" } }),
            ),
            Effect.ignore,
          );
        failing.delete(laptop.sessionId);
        assert.isTrue(yield* isLive(laptop.sessionId));

        // An unrelated change that narrows nothing still ends it.
        const threadId = yield* thread("thread:unrelated");
        yield* access.setLevel({
          personId: narrowed.personId,
          scope: { kind: "thread", threadId },
          level: "viewer",
        });
        assert.isFalse(yield* isLive(laptop.sessionId));
      }),
  );

  it.effect("removes nothing when a person's device cannot be ended first", () =>
    Effect.gen(function* () {
      const access = yield* Access.Access;
      const people = yield* PersonAccess.PersonAccess;
      const kept = yield* person("Kept", [{ scope: { kind: "server" }, level: "owner" }]);
      const phone = yield* device(kept.personId, LEVEL_PERMISSIONS.owner);
      failing.add(phone.sessionId);

      const error = yield* access.removePerson(kept.personId).pipe(Effect.flip);
      failing.delete(phone.sessionId);
      assert.strictEqual(error._tag, "AccessRenewalError");
      assert.isNotEmpty(yield* people.listLevels(kept.personId));
      assert.isTrue(yield* isLive(phone.sessionId));
    }),
  );
});
