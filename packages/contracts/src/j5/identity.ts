import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { J5ActionError } from "./actionError.ts";
import { PersonLevel, PersonScope } from "./levels.ts";
import { SharingPersonName } from "./sharing.ts";

/**
 * Sign-in through the one J5 Connect a server trusts (artifacts/j5-connect/design.md, Identity).
 * Joining, leaving, and deciding who an account is are Owner actions; sign-in never makes a
 * person. These RPCs ride in the People group, so they need no seam in upstream's group.
 */
export const J5_IDENTITY_WS_METHODS = {
  /** The J5 Connect joined, its bound accounts, and the requests waiting. An Owner's request. */
  getIdentity: "j5.identity.get",
  /** The return addresses to register for this server before joining. */
  returnUrls: "j5.identity.returnUrls",
  join: "j5.identity.join",
  leave: "j5.identity.leave",
  /** Lets in an account that is no one yet, as a new person at a scope and level. */
  grant: "j5.identity.grant",
  /** Says an account is someone already on the server. */
  bind: "j5.identity.bind",
  decline: "j5.identity.decline",
  unbind: "j5.identity.unbind",
} as const;

/** Where a device starts signing in; it is sent on to the J5 Connect. Takes no sign-in. */
export const J5_IDENTITY_SIGN_IN_PATH = "/api/j5/identity/sign-in";
/** Where the J5 Connect sends the browser back. Each registered return address ends here. */
export const J5_IDENTITY_CALLBACK_PATH = "/api/j5/identity/callback";
/** Whether this server offers sign-in, for the pairing page. Takes no sign-in. */
export const J5_IDENTITY_DESCRIBE_PATH = "/api/j5/identity/describe";
/** The `j5 auth connect` commands, through a running server. */
export const J5_IDENTITY_CLI_JOIN_PATH = "/api/j5/identity/cli/join";
export const J5_IDENTITY_CLI_LEAVE_PATH = "/api/j5/identity/cli/leave";
export const J5_IDENTITY_CLI_RETURN_URLS_PATH = "/api/j5/identity/cli/return-urls";

/**
 * What the callback tells the pairing page in its query, as `j5-sign-in=<outcome>`: waiting for
 * an Owner, not let in (declined or expired, said alike), or the sign-in itself failed. A sign-in
 * that pairs goes to `/pair#token=…` as a link does.
 */
export const SignInOutcome = Schema.Literals(["waiting", "not-let-in", "failed"]);
export type SignInOutcome = typeof SignInOutcome.Type;
export const J5_SIGN_IN_OUTCOME_PARAM = "j5-sign-in";

export const IdentityDescription = Schema.Struct({
  /** The J5 Connect's host, to name it on the button; `null` when the server trusts none. */
  signIn: Schema.NullOr(Schema.Struct({ host: Schema.String })),
});
export type IdentityDescription = typeof IdentityDescription.Type;

const HttpUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { expected: "an http:// or https:// URL" },
  ),
);

export const JoinConnectRequest = Schema.Struct({
  issuer: HttpUrl,
  clientId: TrimmedNonEmptyString,
  clientSecret: TrimmedNonEmptyString,
  /**
   * Addresses this server is reached at beyond those it finds itself (its loopback, LAN and
   * tailnet addresses), such as the one the browser joining is at. Each gets a return address.
   */
  addresses: Schema.optionalKey(Schema.Array(HttpUrl)),
});
export type JoinConnectRequest = typeof JoinConnectRequest.Type;

export const ReturnUrlsRequest = Schema.Struct({
  addresses: Schema.optionalKey(Schema.Array(HttpUrl)),
});
export type ReturnUrlsRequest = typeof ReturnUrlsRequest.Type;

export const ReturnUrls = Schema.Struct({ returnUrls: Schema.Array(Schema.String) });
export type ReturnUrls = typeof ReturnUrls.Type;

export const JoinedConnect = Schema.Struct({
  issuer: Schema.String,
  clientId: Schema.String,
  returnUrls: Schema.Array(Schema.String),
  joinedAt: Schema.DateTimeUtc,
});
export type JoinedConnect = typeof JoinedConnect.Type;
/** How the `j5 auth connect join` route sends `JoinedConnect`, and the CLI reads it. */
export const JoinedConnectJson = Schema.toCodecJson(JoinedConnect);

export const BoundAccount = Schema.Struct({
  accountId: Schema.String,
  personId: Schema.String,
  personName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  /** When the J5 Connect last said the account is still active; `null` before the first time. */
  lastConfirmedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type BoundAccount = typeof BoundAccount.Type;

export const AccessRequest = Schema.Struct({
  accountId: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtc,
  /**
   * Someone on the server with the account's name and no account, offered to the Owner as "is
   * this them?". A suggestion only: nothing is bound until an Owner says so.
   */
  suggested: Schema.NullOr(Schema.Struct({ personId: Schema.String, name: Schema.String })),
});
export type AccessRequest = typeof AccessRequest.Type;

export const IdentityState = Schema.Struct({
  connect: Schema.NullOr(JoinedConnect),
  accounts: Schema.Array(BoundAccount),
  requests: Schema.Array(AccessRequest),
});
export type IdentityState = typeof IdentityState.Type;

export const AccountIdRequest = Schema.Struct({ accountId: TrimmedNonEmptyString });
export type AccountIdRequest = typeof AccountIdRequest.Type;

export const GrantAccountRequest = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  name: SharingPersonName,
  scope: PersonScope,
  level: PersonLevel,
});
export type GrantAccountRequest = typeof GrantAccountRequest.Type;

export const BindAccountRequest = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  personId: TrimmedNonEmptyString,
});
export type BindAccountRequest = typeof BindAccountRequest.Type;

export const UnbindAccountRequest = Schema.Struct({ personId: TrimmedNonEmptyString });
export type UnbindAccountRequest = typeof UnbindAccountRequest.Type;

const IdentityError = Schema.Union([J5ActionError, EnvironmentAuthorizationError]);
const Done = Schema.Struct({});

export const J5IdentityRpcGroup = RpcGroup.make(
  Rpc.make(J5_IDENTITY_WS_METHODS.getIdentity, {
    payload: Schema.Struct({}),
    success: IdentityState,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.returnUrls, {
    payload: ReturnUrlsRequest,
    success: ReturnUrls,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.join, {
    payload: JoinConnectRequest,
    success: JoinedConnect,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.leave, {
    payload: Schema.Struct({}),
    success: Done,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.grant, {
    payload: GrantAccountRequest,
    success: Schema.Struct({ personId: Schema.String }),
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.bind, {
    payload: BindAccountRequest,
    success: Done,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.decline, {
    payload: AccountIdRequest,
    success: Done,
    error: IdentityError,
  }),
  Rpc.make(J5_IDENTITY_WS_METHODS.unbind, {
    payload: UnbindAccountRequest,
    success: Done,
    error: IdentityError,
  }),
);
