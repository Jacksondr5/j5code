import { notSteerableStateText, type SteerState } from "@t3tools/client-runtime/j5/steer-state";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Queue-strip header delegate (queue-vs-steer ruling QS3): while the active run
 * has nothing steerable, name its phase next to the queue count and offer
 * Interrupt as an explicit act. Returns null in every other state so the
 * upstream header stays byte-identical when a steer is possible.
 */
export function QueueSteerState(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: SteerState;
}) {
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  const [busy, setBusy] = useState(false);
  if (props.state.kind !== "not-steerable") return null;
  return (
    <span
      data-j5-queue-steer-state={props.state.phase}
      className="ml-auto flex min-w-0 items-center gap-1.5 font-normal"
    >
      <span className="truncate">{notSteerableStateText(props.state.phase)}</span>
      <Button
        size="xs"
        variant="ghost"
        className="h-5 px-1.5 text-[11px] text-foreground"
        disabled={busy}
        title="Interrupt the active run"
        onClick={() => {
          setBusy(true);
          void interrupt({
            environmentId: props.environmentId,
            input: { threadId: props.threadId },
          }).finally(() => setBusy(false));
        }}
      >
        Interrupt
      </Button>
    </span>
  );
}
