import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import type { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";

/**
 * Whether a registration brings a credential other than the one stored for its connection: a
 * re-pair, which can be another person, possibly one who reaches fewer threads.
 */
export const replacesCredential = Effect.fn("j5.replacedCredential.replacesCredential")(function* (
  credentials: ConnectionCredentialStore["Service"],
  registration: ConnectionRegistration,
) {
  if (registration._tag === "RelayConnectionRegistration") return false;
  const stored = yield* credentials
    .get(registration.target.connectionId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return !Option.exists(stored, (credential) => Equal.equals(credential, registration.credential));
});

/** Drops what the last credential cached, so the next one starts from its own answers. */
export const forgetCachedData = Effect.fn("j5.replacedCredential.forgetCachedData")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
) {
  yield* cache.clear(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not clear the cached data of a replaced credential.", {
        environmentId,
        error,
      }),
    ),
  );
});
