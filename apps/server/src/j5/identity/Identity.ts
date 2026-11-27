// @effect-diagnostics nodeBuiltinImport:off - account ids, and the addresses a CLI join finds.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { AuthSessionId } from "@t3tools/contracts";
import {
  type AccessRequest,
  type BoundAccount,
  type IdentityDescription,
  type IdentityState,
  J5_IDENTITY_CALLBACK_PATH,
  type JoinedConnect,
  type PersonLevel,
  type PersonScope,
} from "@t3tools/contracts/j5";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as DirectEndpoints from "../../environment/DirectEndpoints.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import { ReadChanges, layer as readChangesLayer } from "../a2a/ReadChanges.ts";
import { Access } from "../sharing/Access.ts";
import { mintPairingCredential, requireScope } from "../sharing/Links.ts";
import { PairingIntents } from "../sharing/PairingIntents.ts";
import { checkedPersonName } from "../sharing/personNames.ts";
import { PersonAccess, personNameKey } from "../sharing/PersonAccess.ts";
import * as Oidc from "./Oidc.ts";

/**
 * Sign-in through the one J5 Connect a server trusts. A good sign-in mints a J5 link's pairing
 * credential; sign-in never makes a person. Refresh can't tell a disabled account from an outage
 * (Dex answers both alike), so only a day without a confirmation ends an account's sessions.
 */

export class IdentityNotJoinedError extends Schema.TaggedError<IdentityNotJoinedError>()(
  "IdentityNotJoinedError",
  {},
) {
  override get message(): string {
    return "This server trusts no J5 Connect. An Owner joins one with `j5 auth connect join` or in Settings.";
  }
}

export class ClientSecretRefusedError extends Schema.TaggedError<ClientSecretRefusedError>()(
  "ClientSecretRefusedError",
  { clientId: Schema.String },
) {
  override get message(): string {
    return `J5 Connect refused the secret for client ${this.clientId}. Check the client id and secret its operator registered.`;
  }
}

/** Some of this server's addresses are not registered with the J5 Connect, so nothing changed. */
export class ReturnUrlsNotRegisteredError extends Schema.TaggedError<ReturnUrlsNotRegisteredError>()(
  "ReturnUrlsNotRegisteredError",
  {
    clientId: Schema.String,
    toRegister: Schema.Array(Schema.String),
    missing: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      `J5 Connect would not send a browser back to ${String(this.missing.length)} of this server's addresses. Have its operator register these redirect URIs for client ${this.clientId}, then join again:`,
      ...this.toRegister.map((url) => `  ${url}`),
    ].join("\n");
  }
}

/** A sign-in started from an address the J5 Connect was not told about at join. */
export class AddressNotRegisteredError extends Schema.TaggedError<AddressNotRegisteredError>()(
  "AddressNotRegisteredError",
  { origin: Schema.String },
) {
  override get message(): string {
    return `Sign-in isn't set up for ${this.origin}. Open this server at an address an Owner registered when joining J5 Connect, or join again from this one.`;
  }
}

/** The sign-in's state was never issued here, was used, or is more than ten minutes old. */
export class SignInExpiredError extends Schema.TaggedError<SignInExpiredError>()(
  "SignInExpiredError",
  {},
) {
  override get message(): string {
    return "This sign-in expired or was already used. Start it again.";
  }
}

export class AccountNotFoundError extends Schema.TaggedError<AccountNotFoundError>()(
  "AccountNotFoundError",
  { accountId: Schema.String },
) {
  override get message(): string {
    return "That account has not signed in to this server, or its request is gone.";
  }
}

export class AccountAlreadyBoundError extends Schema.TaggedError<AccountAlreadyBoundError>()(
  "AccountAlreadyBoundError",
  {},
) {
  override get message(): string {
    return "That account is already someone's on this server. Unbind it first.";
  }
}

export class PersonAlreadyBoundError extends Schema.TaggedError<PersonAlreadyBoundError>()(
  "PersonAlreadyBoundError",
  { personName: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return `${this.personName ?? "That person"} already has a J5 Connect account here. Unbind it first.`;
  }
}

export class PersonNotBoundError extends Schema.TaggedError<PersonNotBoundError>()(
  "PersonNotBoundError",
  {},
) {
  override get message(): string {
    return "That person has no J5 Connect account here.";
  }
}

export class IdentityPersonNotFoundError extends Schema.TaggedError<IdentityPersonNotFoundError>()(
  "IdentityPersonNotFoundError",
  { personId: Schema.String },
) {
  override get message(): string {
    return "That person is not on this server.";
  }
}

/** Some sign-in sessions could not be ended; they are named so an Owner can end them by hand. */
export class SignInSessionsLiveError extends Schema.TaggedError<SignInSessionsLiveError>()(
  "SignInSessionsLiveError",
  { sessionIds: Schema.Array(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `These sign-in sessions are still live: ${this.sessionIds.join(", ")}. End them by hand in Sharing & access, then try again.`;
  }
}

export class IdentityStorageError extends Schema.TaggedError<IdentityStorageError>()(
  "IdentityStorageError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

/** What a finished sign-in tells the device. */
export type SignInOutcome =
  | { readonly kind: "pair"; readonly credential: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "not-let-in" };

const CLIENT_SECRET_NAME = "j5-connect-client-secret";
const SIGN_IN_LIFETIME = Duration.minutes(10);
/** A request for access is shown to Owners this long; a later sign-in asks again. */
const REQUEST_LIFETIME = Duration.days(7);
/** An account J5 Connect has not confirmed for this long loses its sign-in sessions. */
const CONFIRMATION_LAPSE = Duration.hours(24);
const CONFIRMATION_INTERVAL = Duration.hours(1);

const StoredUrls = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeUrls = Schema.decodeUnknownOption(StoredUrls);
const encodeUrls = Schema.encodeSync(StoredUrls);
const isSqlError = Schema.is(SqlError.SqlError);

type ChangeFailure =
  | IdentityStorageError
  | SignInSessionsLiveError
  | Effect.Error<ReturnType<Access["Service"]["endMcpApprovals"]>>;

export class Identity extends Context.Service<
  Identity,
  {
    /** Whether this server offers sign-in, for the pairing page. */
    readonly describe: Effect.Effect<IdentityDescription, IdentityStorageError>;
    /** The J5 Connect joined, the accounts bound and the requests waiting, for Owners. */
    readonly state: Effect.Effect<IdentityState, IdentityStorageError>;
    /**
     * The return addresses a J5 Connect's operator registers for this server before it joins:
     * one per address it finds itself, and per one of `addresses`.
     */
    readonly returnUrls: (addresses: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * Trusts a J5 Connect, after checking its client's secret and that it sends browsers back to
     * every address of this server: those it finds, and any `addresses` given. Joining another
     * J5 Connect leaves this one first; joining the same one again keeps its bindings.
     */
    readonly join: (input: {
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly addresses: ReadonlyArray<string>;
    }) => Effect.Effect<
      JoinedConnect,
      | Oidc.OidcError
      | ClientSecretRefusedError
      | ReturnUrlsNotRegisteredError
      | ChangeFailure
      | ServerSecretStore.SecretStoreError
    >;
    /** Clears every binding and request, and ends every session that came from sign-in. */
    readonly leave: Effect.Effect<void, ChangeFailure | ServerSecretStore.SecretStoreError>;
    /** Where a browser at `origin` goes to sign in. */
    readonly startSignIn: (
      origin: string,
    ) => Effect.Effect<
      string,
      IdentityNotJoinedError | AddressNotRegisteredError | Oidc.OidcError | IdentityStorageError
    >;
    /** Finishes a sign-in the J5 Connect sent back. */
    readonly completeSignIn: (input: {
      readonly state: string;
      readonly code: string;
    }) => Effect.Effect<
      SignInOutcome,
      | IdentityNotJoinedError
      | SignInExpiredError
      | Oidc.OidcError
      | IdentityStorageError
      | ServerSecretStore.SecretStoreError
      | Effect.Error<ReturnType<typeof mintPairingCredential>>
    >;
    /** Lets in an account that is no one yet, as a new person at a scope and level. */
    readonly grant: (input: {
      readonly accountId: string;
      readonly name: string;
      readonly scope: PersonScope;
      readonly level: PersonLevel;
    }) => Effect.Effect<
      ParticipantId,
      | AccountNotFoundError
      | AccountAlreadyBoundError
      | IdentityStorageError
      | Effect.Error<ReturnType<typeof checkedPersonName>>
      | Effect.Error<ReturnType<PersonAccess["Service"]["createPerson"]>>
      | Effect.Error<ReturnType<Access["Service"]["setLevel"]>>
      | Effect.Error<ReturnType<typeof requireScope>>
    >;
    /** Says an account is someone already on the server. */
    readonly bind: (input: {
      readonly accountId: string;
      readonly personId: string;
    }) => Effect.Effect<
      void,
      | AccountNotFoundError
      | AccountAlreadyBoundError
      | PersonAlreadyBoundError
      | IdentityPersonNotFoundError
      | IdentityStorageError
    >;
    readonly decline: (
      accountId: string,
    ) => Effect.Effect<
      void,
      AccountNotFoundError | AccountAlreadyBoundError | IdentityStorageError
    >;
    /** Cuts a person loose from their account, ending the sessions that came from its sign-in. */
    readonly unbind: (personId: string) => Effect.Effect<void, PersonNotBoundError | ChangeFailure>;
    /**
     * Refreshes every bound account through the J5 Connect, then ends the sign-in sessions of
     * each not confirmed for a day. Run each hour.
     */
    readonly confirmAll: Effect.Effect<void, ChangeFailure | ServerSecretStore.SecretStoreError>;
  }
>()("t3/j5/identity/Identity") {}

interface ConnectRow {
  readonly issuer: string;
  readonly client_id: string;
  readonly return_urls_json: string;
  readonly joined_at: string;
}

interface AccountRow {
  readonly account_id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly person_id: string | null;
  readonly person_removed: number | null;
  readonly refresh_token: string | null;
  readonly last_confirmed_at: string | null;
  readonly requested_at: string | null;
  readonly declined_at: string | null;
}

const toConnect = (row: ConnectRow): JoinedConnect => ({
  issuer: row.issuer,
  clientId: row.client_id,
  returnUrls: Option.getOrElse(decodeUrls(row.return_urls_json), () => []),
  joinedAt: DateTime.makeUnsafe(row.joined_at),
});

const callbackUrl = (origin: string) => `${origin}${J5_IDENTITY_CALLBACK_PATH}`;

/**
 * The addresses this server is reached at, as origins: its loopback address, the LAN and tailnet
 * addresses it advertises, and any given. Each gets one return address on the J5 Connect.
 */
const serverOrigins = Effect.fn("j5.identity.serverOrigins")(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly endpoints: Option.Option<DirectEndpoints.DirectEndpoints["Service"]>;
  readonly extra: ReadonlyArray<string>;
}) {
  const { config, endpoints, extra } = input;
  const bound = Option.isSome(endpoints)
    ? yield* endpoints.value.resolveAvailable()
    : DirectEndpoints.resolveBoundEndpoints({
        platform: yield* HostProcess.Platform,
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
      });
  const origins = [
    `http://localhost:${String(config.port)}`,
    ...bound.map((endpoint) => new URL(endpoint.httpBaseUrl).origin),
    ...extra.map((address) => new URL(address).origin),
  ];
  return [...new Set(origins)];
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;
  const access = yield* Access;
  const intents = yield* PairingIntents;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const directEndpoints = yield* Effect.serviceOption(DirectEndpoints.DirectEndpoints);
  const peopleChanged = (yield* ReadChanges).notify("sharing");
  const storage = (operation: string) => (cause: unknown) =>
    new IdentityStorageError({ operation, cause });
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const ago = (duration: Duration.Duration) =>
    DateTime.now.pipe(
      Effect.map((now) =>
        DateTime.formatIso(DateTime.subtract(now, { milliseconds: Duration.toMillis(duration) })),
      ),
    );
  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.provideService(effect, HttpClient.HttpClient, httpClient);
  const committed = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isSqlError(cause)
            ? new IdentityStorageError({ operation, cause })
            : (cause as Exclude<E, SqlError.SqlError>),
        ),
      );

  const returnUrls = (addresses: ReadonlyArray<string>) =>
    serverOrigins({ config, endpoints: directEndpoints, extra: addresses }).pipe(
      Effect.map((origins) => origins.map(callbackUrl)),
    );

  const readConnect = sql<ConnectRow>`
    SELECT issuer, client_id, return_urls_json, joined_at FROM j5_identity_connect
  `.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(storage("read the J5 Connect this server trusts")),
  );

  const requireConnect = readConnect.pipe(
    Effect.filterOrFail(
      (row): row is ConnectRow => row !== null,
      () => new IdentityNotJoinedError({}),
    ),
  );

  const clientSecret = secrets.get(CLIENT_SECRET_NAME).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new IdentityNotJoinedError({})),
        onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
      }),
    ),
  );

  const selectAccounts = sql`
    SELECT account.account_id, account.issuer, account.subject, account.email, account.name,
      account.person_id, person.removed_at IS NOT NULL AS person_removed, account.refresh_token,
      account.last_confirmed_at, account.requested_at, account.declined_at
    FROM j5_identity_account AS account
    LEFT JOIN j5_a2a_human_person AS person ON person.person_id = account.person_id
  `;

  const readAccount = (accountId: string) =>
    sql<AccountRow>`${selectAccounts} WHERE account.account_id = ${accountId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(storage("read an account")),
    );

  /**
   * Ends every session that came from an account's sign-in, through the gate's revoke, which ends
   * a device key's other sessions too and closes open sockets; and revokes the credentials a
   * sign-in minted that no device has exchanged yet.
   */
  const endSignIn = Effect.fn("j5.identity.endSignIn")(function* (accountId: string) {
    const sessions = yield* sql<{ readonly session_id: AuthSessionId }>`
      SELECT session_id FROM j5_a2a_person_session WHERE sign_in_account_id = ${accountId}
    `.pipe(Effect.mapError(storage("read the sessions an account signed in")));
    const stillLive: Array<string> = [];
    let firstCause: unknown;
    for (const { session_id: sessionId } of sessions) {
      const ended = yield* Effect.result(auth.revokeClient(sessionId));
      if (ended._tag === "Failure") {
        stillLive.push(sessionId);
        firstCause ??= ended.failure;
      }
    }
    const waiting = yield* sql<{ readonly pairing_link_id: string }>`
      SELECT pairing_link_id FROM j5_a2a_pairing_intent WHERE sign_in_account_id = ${accountId}
    `.pipe(Effect.mapError(storage("read an account's waiting sign-ins")));
    for (const credential of waiting) {
      yield* grants
        .revoke(credential.pairing_link_id)
        .pipe(Effect.mapError(storage("revoke a waiting sign-in")));
      yield* intents
        .forget(credential.pairing_link_id)
        .pipe(Effect.mapError(storage("forget a waiting sign-in")));
    }
    if (stillLive.length > 0) {
      return yield* new SignInSessionsLiveError({ sessionIds: stillLive, cause: firstCause });
    }
  });

  /** Forgets every account and sign-in, after ending what came from them. */
  const clearAccounts = Effect.fn("j5.identity.clearAccounts")(function* () {
    const accounts = yield* sql<{ readonly account_id: string }>`
      SELECT account_id FROM j5_identity_account
    `.pipe(Effect.mapError(storage("read the accounts")));
    for (const account of accounts) yield* endSignIn(account.account_id);
    yield* committed(
      "forget the accounts",
      Effect.gen(function* () {
        yield* sql`DELETE FROM j5_identity_account`;
        yield* sql`DELETE FROM j5_identity_sign_in`;
      }),
    );
  });

  const leave: Identity["Service"]["leave"] = Effect.gen(function* () {
    yield* clearAccounts();
    yield* sql`DELETE FROM j5_identity_connect`.pipe(Effect.mapError(storage("leave J5 Connect")));
    yield* secrets.remove(CLIENT_SECRET_NAME);
    yield* peopleChanged;
  }).pipe(Effect.withSpan("j5.identity.leave"));

  const requestsAndAccounts = Effect.fn("j5.identity.requestsAndAccounts")(function* () {
    const since = yield* ago(REQUEST_LIFETIME);
    const rows = yield* sql<AccountRow & { readonly person_name: string | null }>`
      SELECT account.account_id, account.issuer, account.subject, account.email, account.name,
        account.person_id, person.removed_at IS NOT NULL AS person_removed,
        person.display_name AS person_name, account.refresh_token, account.last_confirmed_at,
        account.requested_at, account.declined_at
      FROM j5_identity_account AS account
      LEFT JOIN j5_a2a_human_person AS person ON person.person_id = account.person_id
      ORDER BY account.requested_at DESC, account.account_id
    `;
    const accounts: Array<BoundAccount> = [];
    const requests: Array<AccessRequest> = [];
    for (const row of rows) {
      if (row.person_id !== null && row.person_removed !== 1) {
        accounts.push({
          accountId: row.account_id,
          personId: row.person_id,
          personName: row.person_name,
          email: row.email,
          name: row.name,
          lastConfirmedAt:
            row.last_confirmed_at === null ? null : DateTime.makeUnsafe(row.last_confirmed_at),
        });
      } else if (
        row.person_id === null &&
        row.requested_at !== null &&
        row.declined_at === null &&
        row.requested_at > since
      ) {
        // A suggestion by name only: someone here with that name and no account of their own.
        const suggested =
          row.name === null
            ? []
            : yield* sql<{ readonly person_id: string; readonly display_name: string }>`
                SELECT person.person_id, person.display_name FROM j5_a2a_human_person AS person
                WHERE person.name_key = ${personNameKey(row.name)} AND person.removed_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM j5_identity_account AS bound
                    WHERE bound.person_id = person.person_id
                  )
              `;
        requests.push({
          accountId: row.account_id,
          email: row.email,
          name: row.name,
          requestedAt: DateTime.makeUnsafe(row.requested_at),
          suggested:
            suggested[0] === undefined
              ? null
              : { personId: suggested[0].person_id, name: suggested[0].display_name },
        });
      }
    }
    return { accounts, requests };
  });

  /** Ends an account's sign-in for good: its sessions, its refresh token, its MCP clients. */
  const lapse = Effect.fn("j5.identity.lapse")(function* (account: {
    readonly account_id: string;
    readonly person_id: string;
  }) {
    yield* Effect.logInfo("J5 Connect has not confirmed an account for a day; ending its sign-in", {
      accountId: account.account_id,
    });
    yield* endSignIn(account.account_id);
    yield* sql`
      UPDATE j5_identity_account SET refresh_token = NULL WHERE account_id = ${account.account_id}
    `.pipe(Effect.mapError(storage("forget a lapsed account's refresh token")));
    yield* access.endMcpApprovals(ParticipantId.make(account.person_id));
  });

  const confirmAll: Identity["Service"]["confirmAll"] = Effect.gen(function* () {
    const connect = yield* readConnect;
    if (connect === null) return;
    const confirming = yield* sql<{
      readonly account_id: string;
      readonly subject: string;
      readonly refresh_token: string;
    }>`
      SELECT account.account_id, account.subject, account.refresh_token
      FROM j5_identity_account AS account
      JOIN j5_a2a_human_person AS person
        ON person.person_id = account.person_id AND person.removed_at IS NULL
      WHERE account.refresh_token IS NOT NULL
    `.pipe(Effect.mapError(storage("read the accounts to confirm")));
    if (confirming.length > 0) {
      // An outage here, or J5 Connect refusing, is not acted on: only a day without a
      // confirmation ends a sign-in, since Dex answers both with the same error.
      const reached = yield* withHttp(Oidc.discover(connect.issuer)).pipe(
        Effect.flatMap((discovery) =>
          clientSecret.pipe(Effect.map((secret) => ({ discovery, secret }))),
        ),
        Effect.option,
      );
      if (Option.isSome(reached)) {
        const { discovery, secret } = reached.value;
        for (const account of confirming) {
          const refreshed = yield* withHttp(
            Oidc.refresh({
              discovery,
              clientId: connect.client_id,
              clientSecret: secret,
              refreshToken: account.refresh_token,
              subject: account.subject,
              nowMillis: yield* nowMillis,
            }),
          ).pipe(Effect.result);
          if (refreshed._tag === "Failure") {
            yield* Effect.logWarning("J5 Connect did not confirm an account", {
              accountId: account.account_id,
              cause: refreshed.failure,
            });
            continue;
          }
          yield* sql`
            UPDATE j5_identity_account
            SET refresh_token = ${refreshed.success}, last_confirmed_at = ${yield* nowIso}
            WHERE account_id = ${account.account_id}
          `.pipe(Effect.mapError(storage("record a confirmation")));
        }
      } else {
        yield* Effect.logWarning("J5 Connect could not be reached to confirm accounts");
      }
    }
    const cutoff = yield* ago(CONFIRMATION_LAPSE);
    const lapsed = yield* sql<{ readonly account_id: string; readonly person_id: string }>`
      SELECT account.account_id, account.person_id FROM j5_identity_account AS account
      WHERE account.person_id IS NOT NULL
        AND (account.last_confirmed_at IS NULL OR account.last_confirmed_at <= ${cutoff})
        AND (
          account.refresh_token IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM j5_a2a_person_session AS session
            WHERE session.sign_in_account_id = account.account_id
          )
          OR EXISTS (
            SELECT 1 FROM j5_a2a_pairing_intent AS intent
            WHERE intent.sign_in_account_id = account.account_id
          )
        )
    `.pipe(Effect.mapError(storage("read the accounts not confirmed")));
    for (const account of lapsed) yield* lapse(account);
  }).pipe(Effect.withSpan("j5.identity.confirmAll"));

  return Identity.of({
    describe: readConnect.pipe(
      Effect.map((row) => ({ signIn: row === null ? null : { host: new URL(row.issuer).host } })),
      Effect.withSpan("j5.identity.describe"),
    ),

    state: Effect.gen(function* () {
      const connect = yield* readConnect;
      const { accounts, requests } = yield* requestsAndAccounts().pipe(
        Effect.mapError(storage("read the accounts and requests")),
      );
      return { connect: connect === null ? null : toConnect(connect), accounts, requests };
    }).pipe(Effect.withSpan("j5.identity.state")),

    returnUrls,

    join: Effect.fn("j5.identity.join")(function* (input) {
      const discovery = yield* withHttp(Oidc.discover(input.issuer));
      const toRegister = yield* returnUrls(input.addresses);
      const accepted = yield* withHttp(
        Oidc.secretAccepted({
          discovery,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          returnUrl: toRegister[0]!,
        }),
      );
      if (!accepted) return yield* new ClientSecretRefusedError({ clientId: input.clientId });
      const missing: Array<string> = [];
      for (const returnUrl of toRegister) {
        const registered = yield* withHttp(
          Oidc.returnUrlRegistered({ discovery, clientId: input.clientId, returnUrl }),
        );
        if (!registered) missing.push(returnUrl);
      }
      if (missing.length > 0) {
        return yield* new ReturnUrlsNotRegisteredError({
          clientId: input.clientId,
          toRegister,
          missing,
        });
      }
      // Changing the J5 Connect is leaving the old one: whoever runs it no longer vouches here.
      const current = yield* readConnect;
      if (current !== null && current.issuer !== input.issuer) yield* clearAccounts();
      yield* secrets.set(CLIENT_SECRET_NAME, new TextEncoder().encode(input.clientSecret));
      const joinedAt = yield* nowIso;
      const row: ConnectRow = {
        issuer: input.issuer,
        client_id: input.clientId,
        return_urls_json: encodeUrls(toRegister),
        joined_at: joinedAt,
      };
      yield* sql`
        INSERT INTO j5_identity_connect (singleton, issuer, client_id, return_urls_json, joined_at)
        VALUES (1, ${row.issuer}, ${row.client_id}, ${row.return_urls_json}, ${row.joined_at})
        ON CONFLICT (singleton) DO UPDATE SET
          issuer = excluded.issuer,
          client_id = excluded.client_id,
          return_urls_json = excluded.return_urls_json,
          joined_at = excluded.joined_at
      `.pipe(Effect.mapError(storage("join J5 Connect")));
      yield* peopleChanged;
      return toConnect(row);
    }),

    leave,

    startSignIn: Effect.fn("j5.identity.startSignIn")(function* (origin) {
      const connect = yield* requireConnect;
      const returnUrl = callbackUrl(origin);
      if (!toConnect(connect).returnUrls.includes(returnUrl)) {
        return yield* new AddressNotRegisteredError({ origin });
      }
      const discovery = yield* withHttp(Oidc.discover(connect.issuer));
      const signIn = Oidc.newSignIn();
      const now = yield* DateTime.now;
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: Duration.toMillis(SIGN_IN_LIFETIME) }),
      );
      yield* committed(
        "start a sign-in",
        Effect.gen(function* () {
          yield* sql`DELETE FROM j5_identity_sign_in WHERE expires_at <= ${DateTime.formatIso(now)}`;
          yield* sql`
            INSERT INTO j5_identity_sign_in (state, nonce, code_verifier, return_url, expires_at)
            VALUES (
              ${signIn.state}, ${signIn.nonce}, ${signIn.codeVerifier}, ${returnUrl}, ${expiresAt}
            )
          `;
        }),
      );
      return Oidc.authorizationUrl({
        discovery,
        clientId: connect.client_id,
        returnUrl,
        state: signIn.state,
        nonce: signIn.nonce,
        codeChallenge: signIn.codeChallenge,
      });
    }),

    completeSignIn: Effect.fn("j5.identity.completeSignIn")(function* (input) {
      const now = yield* nowIso;
      // Taken once: a state replayed, or one older than ten minutes, is refused.
      const taken = yield* sql<{
        readonly nonce: string;
        readonly code_verifier: string;
        readonly return_url: string;
      }>`
        DELETE FROM j5_identity_sign_in WHERE state = ${input.state} AND expires_at > ${now}
        RETURNING nonce, code_verifier, return_url
      `.pipe(Effect.mapError(storage("finish a sign-in")));
      const pending = taken[0];
      if (pending === undefined) return yield* new SignInExpiredError({});
      const connect = yield* requireConnect;
      const secret = yield* clientSecret;
      const discovery = yield* withHttp(Oidc.discover(connect.issuer));
      const { identity, refreshToken } = yield* withHttp(
        Oidc.exchangeCode({
          discovery,
          clientId: connect.client_id,
          clientSecret: secret,
          code: input.code,
          returnUrl: pending.return_url,
          codeVerifier: pending.code_verifier,
          nonce: pending.nonce,
          nowMillis: yield* nowMillis,
        }),
      );
      const requestSince = yield* ago(REQUEST_LIFETIME);
      const outcome = yield* committed(
        "record a sign-in",
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO j5_identity_account (account_id, issuer, subject, email, name)
            VALUES (
              ${`account:${NodeCrypto.randomUUID()}`}, ${identity.issuer}, ${identity.subject},
              ${identity.email}, ${identity.name}
            )
            ON CONFLICT (issuer, subject) DO UPDATE SET
              email = excluded.email, name = excluded.name
          `;
          const [account] = yield* sql<AccountRow>`
            ${selectAccounts}
            WHERE account.issuer = ${identity.issuer} AND account.subject = ${identity.subject}
          `;
          if (account === undefined) return yield* Effect.die("account just written is missing");
          if (account.person_id !== null && account.person_removed !== 1) {
            yield* sql`
              UPDATE j5_identity_account
              SET refresh_token = ${refreshToken}, last_confirmed_at = ${now}
              WHERE account_id = ${account.account_id}
            `;
            const credential = yield* mintPairingCredential({
              linkId: null,
              signInAccountId: account.account_id,
              personId: ParticipantId.make(account.person_id),
              name: null,
            }).pipe(
              Effect.provideService(PersonAccess, people),
              Effect.provideService(PairingIntents, intents),
              Effect.provideService(PairingGrantStore.PairingGrantStore, grants),
            );
            return { kind: "pair" as const, credential };
          }
          // A request already in force stands, declined or waiting; otherwise this one asks.
          if (
            account.person_id === null &&
            account.requested_at !== null &&
            account.requested_at > requestSince
          ) {
            return account.declined_at === null
              ? { kind: "waiting" as const }
              : { kind: "not-let-in" as const };
          }
          // Bound to someone since removed, or a request that expired: it asks afresh.
          yield* sql`
            UPDATE j5_identity_account
            SET person_id = NULL, bound_at = NULL, refresh_token = NULL, last_confirmed_at = NULL,
              requested_at = ${now}, declined_at = NULL
            WHERE account_id = ${account.account_id}
          `;
          return { kind: "waiting" as const };
        }),
      );
      if (outcome.kind === "waiting") yield* peopleChanged;
      return outcome;
    }),

    grant: Effect.fn("j5.identity.grant")(function* (input) {
      const name = yield* checkedPersonName(input.name);
      yield* requireScope(sql, input.scope);
      const personId = yield* committed(
        "let an account in",
        Effect.gen(function* () {
          const account = yield* readAccount(input.accountId);
          if (account === null) {
            return yield* new AccountNotFoundError({ accountId: input.accountId });
          }
          if (account.person_id !== null && account.person_removed !== 1) {
            return yield* new AccountAlreadyBoundError({});
          }
          const person = yield* people.createPerson({ displayName: name });
          yield* access.setLevel({
            personId: person.personId,
            scope: input.scope,
            level: input.level,
          });
          const now = yield* nowIso;
          yield* sql`
            UPDATE j5_identity_account
            SET person_id = ${person.personId}, bound_at = ${now}, requested_at = NULL,
              declined_at = NULL
            WHERE account_id = ${input.accountId}
          `.pipe(Effect.mapError(storage("bind an account")));
          return person.personId;
        }),
      );
      yield* peopleChanged;
      return personId;
    }),

    bind: Effect.fn("j5.identity.bind")(function* (input) {
      yield* committed(
        "bind an account",
        Effect.gen(function* () {
          const account = yield* readAccount(input.accountId);
          if (account === null) {
            return yield* new AccountNotFoundError({ accountId: input.accountId });
          }
          if (account.person_id !== null && account.person_removed !== 1) {
            return yield* new AccountAlreadyBoundError({});
          }
          const person = yield* people
            .readPerson(ParticipantId.make(input.personId))
            .pipe(Effect.mapError(storage("read a person")));
          if (person === null) {
            return yield* new IdentityPersonNotFoundError({ personId: input.personId });
          }
          const already = yield* sql`
            SELECT 1 AS found FROM j5_identity_account WHERE person_id = ${input.personId}
          `.pipe(Effect.mapError(storage("read a person's account")));
          if (already.length > 0) {
            return yield* new PersonAlreadyBoundError({ personName: person.displayName });
          }
          const now = yield* nowIso;
          yield* sql`
            UPDATE j5_identity_account
            SET person_id = ${input.personId}, bound_at = ${now}, requested_at = NULL,
              declined_at = NULL
            WHERE account_id = ${input.accountId}
          `.pipe(Effect.mapError(storage("bind an account")));
        }),
      );
      yield* peopleChanged;
    }),

    decline: Effect.fn("j5.identity.decline")(function* (accountId) {
      const account = yield* readAccount(accountId);
      if (account === null || account.requested_at === null) {
        return yield* new AccountNotFoundError({ accountId });
      }
      if (account.person_id !== null && account.person_removed !== 1) {
        return yield* new AccountAlreadyBoundError({});
      }
      yield* sql`
        UPDATE j5_identity_account SET declined_at = ${yield* nowIso} WHERE account_id = ${accountId}
      `.pipe(Effect.mapError(storage("decline a request")));
      yield* peopleChanged;
    }),

    unbind: Effect.fn("j5.identity.unbind")(function* (personId) {
      const rows = yield* sql<{ readonly account_id: string }>`
        SELECT account_id FROM j5_identity_account WHERE person_id = ${personId}
      `.pipe(Effect.mapError(storage("read a person's account")));
      const account = rows[0];
      if (account === undefined) return yield* new PersonNotBoundError({});
      yield* endSignIn(account.account_id);
      yield* sql`
        UPDATE j5_identity_account
        SET person_id = NULL, bound_at = NULL, refresh_token = NULL, last_confirmed_at = NULL,
          requested_at = NULL, declined_at = NULL
        WHERE account_id = ${account.account_id}
      `.pipe(Effect.mapError(storage("unbind an account")));
      yield* peopleChanged;
    }),

    confirmAll,
  });
});

// `readChangesLayer` is the one the rest of the server provides, so it is the same instance
// (see `a2a/runtimeLayer.ts`).
export const layer = Layer.effect(Identity, make).pipe(Layer.provide(readChangesLayer));

/** The hourly confirmation, started with the server and stopped with it. */
export const confirmationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const identity = yield* Identity;
    yield* identity.confirmAll.pipe(
      Effect.catchCause((cause) => Effect.logWarning("J5 Connect confirmation failed", { cause })),
      Effect.repeat(Schedule.spaced(CONFIRMATION_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
