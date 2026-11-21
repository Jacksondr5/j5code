import { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

type LinkSessionError = SqlError | EnvironmentAuth.ServerAuthInternalError;

/**
 * The sessions other servers' links hold here, by the server that holds each. Upstream issues a
 * link's session with a name and no environment, so the holder states its own; that is what lets
 * removing a server here end what its links may still do.
 */
export class LinkSessionService extends Context.Service<
  LinkSessionService,
  {
    /**
     * Record which server holds a link's session. A server holds one link to this one, so any
     * earlier session it claimed belongs to a link it has since replaced, and is revoked.
     */
    readonly claim: (input: {
      readonly sessionId: AuthSessionId;
      readonly environmentId: string;
    }) => Effect.Effect<void, LinkSessionError>;
    /** Revoke a link's own session, at its holder's request. */
    readonly release: (sessionId: AuthSessionId) => Effect.Effect<void, LinkSessionError>;
    /** Revoke every session the named server's links hold here; the count of those still live. */
    readonly revokeFor: (environmentId: string) => Effect.Effect<number, LinkSessionError>;
  }
>()("t3/j5/a2a/LinkSessionService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  // Claims and revocations read the records and then act on them; two at once for one server
  // could each revoke the session the other had just recorded.
  const serial = yield* Semaphore.make(1);

  /** A session's record goes only once it is revoked, so a revocation that fails can be tried again. */
  const revokeAndForget = Effect.fn("j5.a2a.linkSessions.revokeAndForget")(function* (
    sessionId: string,
  ) {
    const revoked = yield* serverAuth.revokeSession(AuthSessionId.make(sessionId));
    yield* sql`DELETE FROM j5_link_session WHERE session_id = ${sessionId}`;
    return revoked;
  });

  const revokeEach = Effect.fn("j5.a2a.linkSessions.revokeEach")(function* (
    rows: ReadonlyArray<{ readonly session_id: string }>,
  ) {
    let revoked = 0;
    for (const row of rows) if (yield* revokeAndForget(row.session_id)) revoked += 1;
    return revoked;
  });

  return LinkSessionService.of({
    claim: Effect.fn("j5.a2a.linkSessions.claim")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO j5_link_session (session_id, environment_id, claimed_at)
        VALUES (${input.sessionId}, ${input.environmentId}, ${now})
        ON CONFLICT (session_id) DO UPDATE SET environment_id = excluded.environment_id
      `;
      yield* revokeEach(
        yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM j5_link_session
          WHERE environment_id = ${input.environmentId} AND session_id <> ${input.sessionId}
        `,
      );
    }, serial.withPermit),
    release: Effect.fn("j5.a2a.linkSessions.release")(function* (sessionId) {
      yield* revokeAndForget(sessionId);
    }, serial.withPermit),
    revokeFor: Effect.fn("j5.a2a.linkSessions.revokeFor")(function* (environmentId) {
      return yield* revokeEach(
        yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM j5_link_session WHERE environment_id = ${environmentId}
        `,
      );
    }, serial.withPermit),
  });
});

export const layer = Layer.effect(LinkSessionService, make);
