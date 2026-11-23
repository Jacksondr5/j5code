import { J5ActionError } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

/**
 * Turn a service failure into the error a J5 client action's RPC carries. A refusal (one of
 * `refusals`, or any failure when none are named) keeps its own words. Anything else is the
 * server's own failure: logged here and told in the action's general words.
 */
export const failAsJ5ActionError =
  (options: { readonly refusals?: ReadonlyArray<string>; readonly failed: string }) =>
  (error: { readonly _tag: string; readonly message: string }) =>
    options.refusals === undefined || options.refusals.includes(error._tag)
      ? Effect.fail(new J5ActionError({ code: error._tag, message: error.message }))
      : Effect.logError(options.failed, { cause: error }).pipe(
          Effect.andThen(
            Effect.fail(new J5ActionError({ code: error._tag, message: options.failed })),
          ),
        );
