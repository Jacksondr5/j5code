import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import type { DerivedValue } from "react-native-reanimated";

import { AdjudicationDock } from "../a2a/AdjudicationDock";
import { CrewRosterStrip } from "../crew/CrewRosterStrip";
import { J5OpenParentBar } from "../threads/J5OpenParentBar";

/**
 * J5's rows above a thread's composer, mounted once beside upstream's playbook bar, so each
 * J5 control (a Crew's roster review, Open parent, the adjudication dock) joins here without
 * another seam.
 */
export function J5ComposerControls(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /**
   * Upstream's `pendingUserInputMaxHeight`, the room for its question card, which takes the
   * composer's place; J5's rows sit above the composer, so they also need its height.
   */
  maxHeight: DerivedValue<number>;
  composerHeight: number;
  /** Upstream's `composerBottomInset`, which its room takes off even under the keyboard. */
  composerBottomInset: number;
}) {
  // The dock's room is shared with the rows above it.
  const [rowsHeight, setRowsHeight] = useState(0);
  return (
    <>
      <View onLayout={(event) => setRowsHeight(event.nativeEvent.layout.height)}>
        <CrewRosterStrip environmentId={props.environmentId} threadId={props.threadId} />
        <J5OpenParentBar environmentId={props.environmentId} threadId={props.threadId} />
      </View>
      <AdjudicationDock
        environmentId={props.environmentId}
        threadId={props.threadId}
        maxHeight={props.maxHeight}
        composerHeight={props.composerHeight + rowsHeight}
        composerBottomInset={props.composerBottomInset}
      />
    </>
  );
}
