import { useEffect, useRef } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";

const claim = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Focus props that stop Mod+S (stash), Alt+Up (edit queued) and Mod+Shift+Enter (steer queued)
 * acting on the composer from inside an area such as a Captain's pinned ask. Registered on focus, so
 * it is the newest capture scope; the thread's own listener skips a key whose default is prevented.
 */
export function useClaimedComposerShortcuts() {
  const release = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the claim when the area unmounts with focus inside it.
  useEffect(() => () => release.current?.(), []);
  return {
    onFocus: () => {
      if (release.current !== null) return;
      release.current = registerCommands(
        {
          "composer.stash": claim,
          "thread.editQueuedMessage": claim,
          "thread.steerQueuedMessage": claim,
        },
        // The ask's editor is the composer's own, which the thread treats as composer focus.
        { capture: true, context: () => ({ composerFocus: true }) },
      );
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      release.current?.();
      release.current = null;
    },
  };
}
