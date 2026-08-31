import { type EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  newThreadSquadronName: string | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  newThreadSquadronName,
  activeProjectName,
  activeProjectCwd,
  rightPanelOpen,
  onNewThreadInProject,
}: ChatHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {activeProjectName || newThreadSquadronName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={
                      newThreadSquadronName
                        ? `New thread in ${newThreadSquadronName}`
                        : "Choose Squadron for a new thread"
                    }
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                {activeProjectName ? (
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    className="size-3.5"
                  />
                ) : null}
                <span className="max-w-40 truncate text-sm font-medium">
                  {newThreadSquadronName ?? "Choose Squadron"}
                </span>
                {activeProjectName ? (
                  <span className="max-w-32 truncate text-xs text-muted-foreground/70">
                    {activeProjectName}
                  </span>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {newThreadSquadronName
                  ? `New thread in ${newThreadSquadronName}`
                  : "Choose Squadron for a new thread"}
              </TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
