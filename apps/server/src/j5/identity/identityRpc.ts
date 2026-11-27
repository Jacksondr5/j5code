import { AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";
import {
  type AccountIdRequest,
  type BindAccountRequest,
  type GrantAccountRequest,
  J5_IDENTITY_WS_METHODS,
  type JoinConnectRequest,
  type ReturnUrlsRequest,
  type UnbindAccountRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { failAsJ5ActionError } from "../rpcActionError.ts";
import type { Identity } from "./Identity.ts";

/**
 * Reading who signed in needs upstream's permission to see who has access; joining, leaving and
 * deciding who an account is need its Manage access, which only an Owner's devices hold. None is
 * on the access gate's list, so a narrowed connection is refused all of them.
 */
export const IDENTITY_RPC_SCOPES = {
  [J5_IDENTITY_WS_METHODS.getIdentity]: AuthAccessReadScope,
  [J5_IDENTITY_WS_METHODS.returnUrls]: AuthAccessReadScope,
  [J5_IDENTITY_WS_METHODS.join]: AuthAccessWriteScope,
  [J5_IDENTITY_WS_METHODS.leave]: AuthAccessWriteScope,
  [J5_IDENTITY_WS_METHODS.grant]: AuthAccessWriteScope,
  [J5_IDENTITY_WS_METHODS.bind]: AuthAccessWriteScope,
  [J5_IDENTITY_WS_METHODS.decline]: AuthAccessWriteScope,
  [J5_IDENTITY_WS_METHODS.unbind]: AuthAccessWriteScope,
} as const;

const refused = failAsJ5ActionError({
  refusals: [
    "OidcError",
    "ClientSecretRefusedError",
    "ReturnUrlsNotRegisteredError",
    "AccountNotFoundError",
    "PersonAlreadyBoundError",
    "PersonNotBoundError",
    "IdentityPersonNotFoundError",
    "SignInSessionsLiveError",
    "PersonNameError",
    "PersonNameTakenError",
    "OwnerOutsideServerError",
    "ScopeNotFoundError",
    "AccessRenewalError",
  ],
  failed: "Sign-in could not be read or changed.",
});

export const makeIdentityRpcHandlers = (identity: Identity["Service"]) => ({
  [J5_IDENTITY_WS_METHODS.getIdentity]: () => identity.state.pipe(Effect.catch(refused)),
  [J5_IDENTITY_WS_METHODS.returnUrls]: (input: ReturnUrlsRequest) =>
    identity.returnUrls(input.addresses ?? []).pipe(Effect.map((returnUrls) => ({ returnUrls }))),
  [J5_IDENTITY_WS_METHODS.join]: (input: JoinConnectRequest) =>
    identity
      .join({
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        addresses: input.addresses ?? [],
      })
      .pipe(Effect.catch(refused)),
  [J5_IDENTITY_WS_METHODS.leave]: () => identity.leave.pipe(Effect.as({}), Effect.catch(refused)),
  [J5_IDENTITY_WS_METHODS.grant]: (input: GrantAccountRequest) =>
    identity.grant(input).pipe(
      Effect.map((personId) => ({ personId })),
      Effect.catch(refused),
    ),
  [J5_IDENTITY_WS_METHODS.bind]: (input: BindAccountRequest) =>
    identity.bind(input).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_IDENTITY_WS_METHODS.decline]: (input: AccountIdRequest) =>
    identity.decline(input.accountId).pipe(Effect.as({}), Effect.catch(refused)),
  [J5_IDENTITY_WS_METHODS.unbind]: (input: UnbindAccountRequest) =>
    identity.unbind(input.personId).pipe(Effect.as({}), Effect.catch(refused)),
});
