/**
 * The `j5` command the desktop app writes into its J5 home's `bin` directory
 * (#397). It runs the CLI bundled in the app the way the app starts its own
 * server: the app's executable in Node mode, pointed at the server entry
 * inside `app.asar`. The app rewrites it at every launch, so it follows the
 * app if the app moves; if the app is gone, it says so.
 */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function desktopCliScript(input: {
  readonly executable: string;
  readonly entry: string;
}): string {
  const executable = shellQuote(input.executable);
  return [
    "#!/bin/sh",
    "# J5 Code desktop app: runs the CLI bundled in the app.",
    `if [ ! -x ${executable} ]; then`,
    `  printf 'j5: the J5 Code app is no longer at %s. Open the app once to repair this command.\\n' ${executable} >&2`,
    "  exit 127",
    "fi",
    `ELECTRON_RUN_AS_NODE=1 exec ${executable} ${shellQuote(input.entry)} "$@"`,
    "",
  ].join("\n");
}
