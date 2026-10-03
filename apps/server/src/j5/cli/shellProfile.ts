import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  hasJ5PathLine,
  shellProfilePaths,
  withoutJ5PathLines,
} from "@t3tools/shared/j5/shellProfile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** The shell startup files that hold J5's PATH line, for `j5 uninstall` to show and remove. */
export const findJ5PathLines = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcessEnvironment;
  const home = environment["HOME"];
  if ((yield* HostProcessPlatform) === "win32" || !home) return [];
  const found: Array<string> = [];
  for (const file of shellProfilePaths({ home, zdotdir: environment["ZDOTDIR"] })) {
    const contents = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isSome(contents) && hasJ5PathLine(contents.value)) found.push(file);
  }
  return found;
});

/** Removes J5's PATH line from each file, leaving the rest of the file as it was. */
export const removeJ5PathLines = Effect.fn("j5.cli.remove_path_lines")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = yield* fs.readFileString(file);
    yield* fs.writeFileString(file, withoutJ5PathLines(contents));
  }
});
