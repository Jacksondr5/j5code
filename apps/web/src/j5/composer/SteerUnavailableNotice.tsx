import { notSteerableStateText, type SteerState } from "@t3tools/client-runtime/j5/steer-state";
import { XIcon } from "lucide-react";

import { Button } from "../../components/ui/button";

/**
 * Shown after an explicit steer (Mod+Enter) while nothing is steerable
 * (queue-vs-steer ruling QS3). It states the run's actual phase and offers the
 * two named acts instead of a silent fall-through; it renders nothing once the
 * run becomes steerable or ends, so it can never describe a stale state.
 */
export function SteerUnavailableNotice(props: {
  readonly requested: boolean;
  readonly state: SteerState;
  readonly onInterrupt: () => void;
  readonly onQueueInstead: () => void;
  readonly onDismiss: () => void;
}) {
  if (!props.requested || props.state.kind !== "not-steerable") return null;
  return (
    <div
      role="status"
      data-j5-steer-unavailable={props.state.phase}
      className="mx-3 mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground sm:mx-4"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">Nothing to steer yet.</span>{" "}
        {notSteerableStateText(props.state.phase)}. Your message is still in the composer.
      </span>
      <Button
        size="xs"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={() => {
          props.onDismiss();
          props.onInterrupt();
        }}
      >
        Interrupt
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 px-2 text-[11px]"
        onClick={() => {
          props.onDismiss();
          props.onQueueInstead();
        }}
      >
        Queue instead
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss"
        className="size-6"
        onClick={props.onDismiss}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
