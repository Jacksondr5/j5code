import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { forgetReplacedCredential, savesUnderCurrentCredential } from "./replacedCredential.ts";

describe("forgetReplacedCredential", () => {
  it.effect("does not wait on a save that was interrupted while writing", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-interrupted-save");
      const cleared = yield* Ref.make(false);
      const writing = yield* Deferred.make<void>();
      const save = savesUnderCurrentCredential(environmentId);
      const saving = yield* Effect.forkChild(
        save(Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))),
      );
      yield* Deferred.await(writing);
      yield* Fiber.interrupt(saving);

      yield* forgetReplacedCredential(
        { clear: () => Ref.set(cleared, true) },
        environmentId,
        Effect.void,
      );

      expect(yield* Ref.get(cleared)).toBe(true);
    }),
  );
});
