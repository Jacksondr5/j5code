import type { ThreadHome } from "./ThreadHomesClient";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * Thread cards identify registered work by its immutable Registrar Squadron.
 * Native threads have no Registrar home, so their existing folder label stays
 * as the honest fallback rather than inventing a Squadron.
 */
export function ThreadCardIdentity(props: {
  readonly home: ThreadHome | undefined;
  readonly fallbackFolder: string | null;
}) {
  const label = props.home?.kind === "known" ? props.home.squadron.name : props.fallbackFolder;
  return label === null ? (
    <span className="flex-1" />
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="block truncate">{label}</span>} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
