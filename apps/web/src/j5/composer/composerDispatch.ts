import type { ComposerDispatchMode } from "../../components/chat/composerDispatch";
import type { SessionPhase } from "../../types";

/**
 * J5's active-turn composer policy (queue-vs-steer ruling QS2): a message sent
 * while a run is active queues behind it, and steering is an explicit human
 * action. "Active" covers both the running phase and the connecting phase
 * (preparing / starting), which upstream's default treated as an ordinary
 * send. The Mod+Enter chord (upstream's `queueModifier`) is the keyboard
 * "send now" that steers; the queued row's Steer action is the other explicit
 * door.
 */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly queueModifier: boolean;
}): ComposerDispatchMode {
  if (input.phase !== "running" && input.phase !== "connecting") return "auto";
  return input.queueModifier ? "steer" : "queue";
}
