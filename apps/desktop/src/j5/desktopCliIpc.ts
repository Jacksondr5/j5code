import { DesktopJ5CommandResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeIpcMethod } from "../ipc/DesktopIpc.ts";
import { INSTALL_J5_COMMAND_CHANNEL, UNINSTALL_J5_COMMAND_CHANNEL } from "./desktopCliChannels.ts";
import { installJ5Command, uninstallJ5Command } from "./desktopCliCommand.ts";

export const installJ5CommandMethod = makeIpcMethod({
  channel: INSTALL_J5_COMMAND_CHANNEL,
  payload: Schema.Void,
  result: DesktopJ5CommandResult,
  handler: () => installJ5Command,
});

export const uninstallJ5CommandMethod = makeIpcMethod({
  channel: UNINSTALL_J5_COMMAND_CHANNEL,
  payload: Schema.Void,
  result: DesktopJ5CommandResult,
  handler: () => uninstallJ5Command,
});
