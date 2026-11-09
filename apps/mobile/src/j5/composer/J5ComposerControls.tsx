import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { CrewRosterStrip } from "../crew/CrewRosterStrip";

/**
 * J5's rows above a thread's composer, mounted once beside upstream's playbook bar, so each
 * J5 control (a Crew's roster review, the adjudication dock) joins here without another seam.
 */
export function J5ComposerControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return <CrewRosterStrip environmentId={props.environmentId} threadId={props.threadId} />;
}
