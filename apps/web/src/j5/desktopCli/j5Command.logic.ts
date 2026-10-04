import type { DesktopJ5CommandResult } from "@t3tools/contracts";

export interface J5CommandNotice {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
}

/** What to tell the person after the app installed or removed the `j5` command. */
export function describeJ5CommandResult(result: DesktopJ5CommandResult): J5CommandNotice {
  switch (result.outcome) {
    case "installed":
      return {
        type: "success",
        title: "Installed the j5 command",
        description:
          result.profile !== null
            ? `Linked ${result.command} and added its folder to your PATH in ${result.profile}. Open a new terminal to use it.`
            : result.pathHint !== null
              ? `Linked ${result.command}. Add ${result.pathHint} to your PATH to use it.`
              : `Linked ${result.command}. Its folder is already on your PATH.`,
      };
    case "kept":
      return {
        type: "info",
        title: "j5 is already installed",
        description: `${result.command} comes from another install, such as the command-line installer. Nothing was changed.`,
      };
    case "removed":
      return {
        type: "success",
        title: "Removed the j5 command",
        description:
          result.profile !== null
            ? `Removed ${result.command} and its PATH line from ${result.profile}.`
            : `Removed ${result.command}.`,
      };
    case "nothing":
      return {
        type: "info",
        title: "Nothing to remove",
        description: `${result.command} wasn't installed by this app.`,
      };
    case "unsupported":
      return {
        type: "info",
        title: "Not available here",
        description: "The j5 command can only be installed from the J5 Code app for macOS.",
      };
  }
}
