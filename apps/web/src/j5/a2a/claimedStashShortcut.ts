import { useEffect, useRef } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";

/**
 * Focus props that make Mod+S do nothing inside an area, such as a Captain's pinned ask, rather
 * than stash the composer's prompt. The composer claims the key in the capture phase, where the
 * newest scope wins, so the claim registers on focus, after the composer's.
 */
export function useClaimedStashShortcut() {
  const release = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the claim when the area unmounts with focus inside it.
  useEffect(() => () => release.current?.(), []);
  return {
    onFocus: () => {
      if (release.current !== null) return;
      release.current = registerCommands(
        {
          "composer.stash": (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
        },
        { capture: true },
      );
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      release.current?.();
      release.current = null;
    },
  };
}
