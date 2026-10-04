import { AnchorIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

/**
 * The Captain's mark on a thread card and a Fleet row: an anchor glyph in place of a text badge,
 * since the card has little room left (Jackson, 2026-09-17). The tooltip names the Crews it
 * commands, so the meaning is one hover away and the row keeps its width.
 */
export function CaptainMark(props: { readonly title: string; readonly className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Captain. ${props.title}`}
            data-testid="thread-card-crew-chip"
            className={cn(
              "inline-flex shrink-0 items-center text-muted-foreground",
              props.className,
            )}
          />
        }
      >
        <AnchorIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{props.title}</TooltipPopup>
    </Tooltip>
  );
}
