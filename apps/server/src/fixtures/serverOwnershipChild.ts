// oxlint-disable-next-line t3code/namespace-node-imports -- Node/Bun typings expose once only as a named import.
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { claimStateDirectory } from "../serverRuntimeState.ts";

class StartupFailure extends Schema.TaggedErrorClass<StartupFailure>()("StartupFailure", {
  message: Schema.String,
}) {}

const start = once(process, "message");
process.send?.("ready");
await start;
await Effect.runPromise(
  Effect.gen(function* () {
    yield* claimStateDirectory(process.argv[2]!);
    const stop = once(process, "message");
    process.send?.("acquired");
    const [command] = yield* Effect.promise(() => stop);
    if (command === "fail") return yield* new StartupFailure({ message: "startup failed" });
  }).pipe(
    Effect.scoped,
    Effect.match({
      onSuccess: () => process.send?.("released"),
      onFailure: (error) =>
        process.send?.({
          tag: error._tag,
          message: error.message,
        }),
    }),
    Effect.provide(NodeServices.layer),
  ),
);
process.disconnect?.();
