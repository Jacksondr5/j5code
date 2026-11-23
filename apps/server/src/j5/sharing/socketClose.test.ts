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
import { device, person, recordsLayer } from "./test-support/accessHarness.ts";

/** Each session upstream revoked, and whether a J5 transaction was open around the revoke. */
const revokes: Array<{ readonly sessionId: AuthSessionId; readonly inTransaction: boolean }> = [];

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
          Effect.andThen(real.revoke(sessionId)),
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
