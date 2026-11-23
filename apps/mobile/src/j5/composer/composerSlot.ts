import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/**
 * What the thread screen shares with J5's attention carousel: whether J5's answer panel holds the
 * composer's place, as upstream's question card does, and the height of everything above the
 * keyboard while it does, so the panel measures its room instead of guessing at its neighbours.
 */
export function useJ5ComposerSlot() {
  const [state, setState] = useState({ hidesComposer: false, overlayHeight: 0 });
  // A fresh panel waits for a fresh measure, so a height from an earlier opening never sizes it.
  const setHidesComposer = useCallback(
    (hidesComposer: boolean) =>
      setState((current) =>
        current.hidesComposer === hidesComposer ? current : { hidesComposer, overlayHeight: 0 },
      ),
    [],
  );
  return {
    hidesComposer: state.hidesComposer,
    /** The overlay's layout, read only while the panel is open so typing never re-renders the screen. */
    onOverlayLayout: (event: LayoutChangeEvent) => {
      if (!state.hidesComposer) return;
      const overlayHeight = event.nativeEvent.layout.height;
      setState((current) =>
        current.overlayHeight === overlayHeight ? current : { ...current, overlayHeight },
      );
    },
    controls: { overlayHeight: state.overlayHeight, setHidesComposer },
  };
}

export type J5ComposerSlot = ReturnType<typeof useJ5ComposerSlot>["controls"];
