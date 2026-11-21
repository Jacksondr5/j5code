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

// Bumped each time a re-pair replaces an environment's credential.
const replacements = new Map<EnvironmentId, number>();

/**
 * Whether the environment's credential is still the one it had when this was called. A shell made
 * under a replaced one stops saving, since it lives in its follower's scope and outlasts the
 * registry's teardown: its last flush would put the last person's rows back.
 */
export const credentialStillCurrent = (environmentId: EnvironmentId) => {
  const seen = replacements.get(environmentId) ?? 0;
  return () => (replacements.get(environmentId) ?? 0) === seen;
};

/**
 * Closes the environment's old scope with what the last credential cached forgotten: its shells
 * stop saving first, and the cache is cleared after, so the next credential starts from its own.
 */
export const forgetReplacedCredential = Effect.fn("j5.replacedCredential.forget")(function* <E>(
  cache: Pick<EnvironmentCacheStore["Service"], "clear">,
  environmentId: EnvironmentId,
  closeOldScope: Effect.Effect<void, E>,
) {
  replacements.set(environmentId, (replacements.get(environmentId) ?? 0) + 1);
  yield* closeOldScope;
  yield* cache.clear(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not clear the cached data of a replaced credential.", {
        environmentId,
        error,
      }),
    ),
  );
});
