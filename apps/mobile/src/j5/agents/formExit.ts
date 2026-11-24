/**
 * What Back does on a settings form: leave once saved, wait for a save in flight, or ask before
 * unsaved changes are lost. Back during a save leaves only if that save lands.
 */
export function createFormExit<Action>() {
  let saved = false;
  let waiting: Action | null = null;
  return {
    onBack(action: Action, saving: boolean): "leave" | "wait" | "ask" {
      if (saved) return "leave";
      if (saving) {
        waiting = action;
        return "wait";
      }
      return "ask";
    },
    /** The Back that waited for this save, if any. */
    saveLanded(): Action | null {
      saved = true;
      const action = waiting;
      waiting = null;
      return action;
    },
    saveFailed() {
      waiting = null;
    },
  };
}
