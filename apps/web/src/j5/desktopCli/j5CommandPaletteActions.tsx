import type { DesktopJ5CommandResult } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";

import {
  type CommandPaletteActionItem,
  ITEM_ICON_CLASS,
} from "../../components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { describeJ5CommandResult } from "./j5Command.logic";

const run = (action: () => Promise<DesktopJ5CommandResult>) => async () => {
  try {
    toastManager.add(describeJ5CommandResult(await action()));
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn't change the j5 command",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
};

/**
 * Command palette actions that install or remove the `j5` command for the
 * person's own terminal (#441). Only the desktop app has them: the command
 * links to the CLI built into the app on this machine, whatever environment
 * the app is connected to.
 */
export function j5CommandPaletteActions(): ReadonlyArray<CommandPaletteActionItem> {
  const bridge = window.desktopBridge;
  if (bridge === undefined) return [];
  return [
    {
      kind: "action",
      value: "action:j5:install-command",
      searchTerms: ["j5", "cli", "command", "terminal", "path", "shell", "install"],
      title: "Install 'j5' command in PATH",
      icon: <TerminalIcon className={ITEM_ICON_CLASS} />,
      run: run(() => bridge.installJ5Command()),
    },
    {
      kind: "action",
      value: "action:j5:uninstall-command",
      searchTerms: ["j5", "cli", "command", "terminal", "path", "shell", "uninstall", "remove"],
      title: "Uninstall 'j5' command from PATH",
      icon: <TerminalIcon className={ITEM_ICON_CLASS} />,
      run: run(() => bridge.uninstallJ5Command()),
    },
  ];
}
