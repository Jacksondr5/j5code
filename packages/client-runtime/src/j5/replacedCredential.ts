import type { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
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

interface CredentialSaves {
  /** Bumped each time a re-pair replaces the environment's credential. */
  replaced: number;
  readonly inFlight: Set<Deferred.Deferred<void>>;
}
const environments = new Map<EnvironmentId, CredentialSaves>();
const savesOf = (environmentId: EnvironmentId) => {
  let saves = environments.get(environmentId);
  if (saves === undefined) {
    saves = { replaced: 0, inFlight: new Set() };
    environments.set(environmentId, saves);
  }
  return saves;
};

/**
 * Cache saves held to the environment's credential as it is now. A shell or thread made under a
 * replaced one lives in its follower's scope and outlasts the registry's teardown, so its last
 * flush would put the last person's rows back; once replaced, its saves do nothing.
 */
export const savesUnderCurrentCredential = (environmentId: EnvironmentId) => {
  const saves = savesOf(environmentId);
  const seen = saves.replaced;
  return <E, R>(save: Effect.Effect<void, E, R>) =>
    Effect.suspend(() => {
      if (saves.replaced !== seen) return Effect.void;
      // Recorded in the same step as the check, so a replacement waits for every save it let by.
      const done = Deferred.makeUnsafe<void>();
      saves.inFlight.add(done);
      return save.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            saves.inFlight.delete(done);
            Deferred.doneUnsafe(done, Effect.void);
          }),
        ),
      );
    });
};

/**
 * Closes the environment's old scope with what the last credential cached forgotten: its saves
 * stop first, the ones already writing finish, then the cache is cleared for the next credential.
 */
export const forgetReplacedCredential = Effect.fn("j5.replacedCredential.forget")(function* <E>(
  cache: Pick<EnvironmentCacheStore["Service"], "clear">,
  environmentId: EnvironmentId,
  closeOldScope: Effect.Effect<void, E>,
) {
  const saves = savesOf(environmentId);
  saves.replaced += 1;
  yield* closeOldScope;
  yield* Effect.forEach([...saves.inFlight], Deferred.await, { discard: true });
  yield* cache.clear(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not clear the cached data of a replaced credential.", {
        environmentId,
        error,
      }),
    ),
  );
});
