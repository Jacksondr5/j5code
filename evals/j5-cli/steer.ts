// @effect-diagnostics nodeBuiltinImport:off
/**
 * A message steered into a running Claude turn, as J5 delivers one: a user message with
 * `priority: "next"` pushed on the SDK's streaming input while a foreground shell command runs.
 * A case names the command under `steer.during` and the message under `steer.message`, which may
 * hold a `{{j5:<name>}}` turn. The command is held until Claude Code reports the message queued.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import type { McpToolUseCase, SampleRun } from "../mcp-tool-use/run.ts";

export const Steer = Schema.Struct({
  /** Regex on a Bash command. Its first match is held while the message is pushed. */
  during: Schema.String,
  message: Schema.String,
  /** The agent acted on the message: a call after the held one has this text in its input. */
  acted: Schema.String,
});
export type Steer = typeof Steer.Type;

const steers = new WeakMap<McpToolUseCase, Steer>();
export const steerFor = (testCase: McpToolUseCase) => steers.get(testCase);
export const setSteer = (testCase: McpToolUseCase, steer: Steer) => {
  steers.set(testCase, steer);
  return testCase;
};

/** A shell command that waits for `release` to exist, after marking that it started. */
export const heldCommand = (command: string, files: { started: string; release: string }) =>
  `touch ${files.started}; while [ ! -e ${files.release} ]; do sleep 0.2; done; ${command}`;

export const whenExists = (file: string) =>
  new Promise<void>((resolve) => {
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      if (!NodeFS.existsSync(file)) return;
      watcher.close();
      resolve();
    });
    if (NodeFS.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });

/** Pass: a call after the held command carries `acted` in its input. */
export const gradeSteer = (steer: Steer, run: SampleRun) => {
  const held = run.calls.findIndex(
    (call) =>
      call.tool === "Bash" &&
      typeof (call.input as { command?: unknown }).command === "string" &&
      new RegExp(steer.during).test((call.input as { command: string }).command),
  );
  const acted =
    held !== -1 &&
    run.calls.slice(held + 1).some((call) => JSON.stringify(call.input).includes(steer.acted));
  return [{ check: `steer acted: a later call names ${steer.acted}`, pass: acted }];
};
