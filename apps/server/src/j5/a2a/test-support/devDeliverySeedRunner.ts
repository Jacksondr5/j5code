import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { parseDevDeliverySeedArgs, runDevDeliverySeed } from "./devDeliverySeed.ts";

if (import.meta.main) {
  const main = async () => {
    try {
      const { baseDir } = parseDevDeliverySeedArgs(process.argv.slice(2));
      const receipt = await Effect.runPromise(
        runDevDeliverySeed(baseDir).pipe(
          Effect.provide(Logger.layer([], { mergeWithExisting: false })),
        ),
      );
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  };
  void main();
}
