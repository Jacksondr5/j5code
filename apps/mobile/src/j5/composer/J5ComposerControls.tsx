import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DerivedValue } from "react-native-reanimated";

import { AdjudicationDock } from "../a2a/AdjudicationDock";
import { CrewRosterStrip } from "../crew/CrewRosterStrip";

/**
 * J5's rows above a thread's composer, mounted once beside upstream's playbook bar, so each
 * J5 control (a Crew's roster review, the adjudication dock) joins here without another seam.
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
}) {
  return (
    <>
      <CrewRosterStrip environmentId={props.environmentId} threadId={props.threadId} />
      <AdjudicationDock
        environmentId={props.environmentId}
        threadId={props.threadId}
        maxHeight={props.maxHeight}
        composerHeight={props.composerHeight}
      />
    </>
  );
}
