import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  hasJ5PathLine,
  shellProfilePaths,
  withoutJ5PathLines,
} from "@t3tools/shared/j5/shellProfile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

// Profiles needn't be UTF-8. Reading each byte as one latin1 character keeps
// every byte through the edit; the marker itself is ASCII.
const asBytes = (contents: Uint8Array) => Buffer.from(contents).toString("latin1");

/** The shell startup files that hold J5's PATH line, for `j5 uninstall` to show and remove. */
export const findJ5PathLines = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcessEnvironment;
  const home = environment["HOME"];
  if ((yield* HostProcessPlatform) === "win32" || !home) return [];
  const found: Array<string> = [];
  const files = shellProfilePaths({
    home,
    zdotdir: environment["ZDOTDIR"],
    xdgConfigHome: environment["XDG_CONFIG_HOME"],
  });
  for (const file of files) {
    const contents = yield* fs.readFile(file).pipe(Effect.option);
    if (Option.isSome(contents) && hasJ5PathLine(asBytes(contents.value))) found.push(file);
  }
  return found;
});

/** Removes J5's PATH line from each file, leaving every other byte as it was. */
export const removeJ5PathLines = Effect.fn("j5.cli.remove_path_lines")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = asBytes(yield* fs.readFile(file));
    yield* fs.writeFile(file, Buffer.from(withoutJ5PathLines(contents), "latin1"));
  }
});
