import * as Schema from "effect/Schema";

/**
 * What the desktop app did when asked to install or remove the `j5` command
 * for the person's own terminal (#441). The app's agents never need this;
 * they get `j5` from the J5 home's `bin` directory.
 */
export const DesktopJ5CommandResult = Schema.Struct({
  outcome: Schema.Literals([
    /** `command` now runs the app's CLI. */
    "installed",
    /** A `j5` from something else, such as a command-line install, is at `command`; left alone. */
    "kept",
    /** The app's `command` is gone. */
    "removed",
    /** There was no command of the app's to remove. */
    "nothing",
    /** Not the packaged macOS app. */
    "unsupported",
  ]),
  /** Where the command lives, for example `~/.local/bin/j5`. */
  command: Schema.String,
  /** The shell startup file whose PATH line was added or removed, if any. */
  profile: Schema.NullOr(Schema.String),
  /** After an install: the directory to add to PATH by hand, when no startup file could be edited. */
  pathHint: Schema.NullOr(Schema.String),
});
export type DesktopJ5CommandResult = typeof DesktopJ5CommandResult.Type;
