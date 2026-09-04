import type { ComposerDispatchMode } from "../../components/chat/composerDispatch";
import type { SessionPhase } from "../../types";

/**
 * J5's active-turn composer policy (issue #73): a message sent while a turn is
 * running queues behind it, and steering is an explicit human action. The
 * Mod+Enter chord (upstream's `queueModifier`) is the keyboard "send now"
 * that steers; the queued row's Steer action is the other explicit door.
 */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly queueModifier: boolean;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  return input.queueModifier ? "steer" : "queue";
}
