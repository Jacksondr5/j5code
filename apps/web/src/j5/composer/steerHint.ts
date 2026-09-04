import {
  notSteerableStateText,
  steerShortcutHint,
  type SteerState,
} from "@t3tools/client-runtime/j5/steer-state";

export interface ComposerSteerHint {
  /** Whether the hint is a keyboard chord (rendered with the shortcut label) or a state sentence. */
  readonly shortcut: boolean;
  readonly text: string;
}

/**
 * The hint beside the composer while a run is active: the chord and what it
 * does on this provider when a steer is possible (QS4), or the run's actual
 * state when it is not (QS3).
 */
export function composerSteerHint(state: SteerState): ComposerSteerHint {
  switch (state.kind) {
    case "steerable":
      return { shortcut: true, text: steerShortcutHint(state.act) };
    case "not-steerable":
      return { shortcut: false, text: notSteerableStateText(state.phase) };
    case "idle":
      return { shortcut: true, text: steerShortcutHint("steer-now") };
  }
}
