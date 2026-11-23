import {
  runAtomCommand,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../state/atom-registry";

/**
 * Runs a command from a J5 Promise edge and hands back its result. Callers report a failure
 * themselves, as they did before upstream's commands became Effects.
 */
export const runJ5Command = <W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Promise<AtomCommandResult<A, E>> =>
  runAtomCommand(appAtomRegistry, command, input, { reportFailure: false, reportDefect: false });
