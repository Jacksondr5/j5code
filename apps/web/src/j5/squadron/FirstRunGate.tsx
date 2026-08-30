import type { ReactNode } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { SidebarInset } from "../../components/ui/sidebar";
import type { SquadronFirstRunGateState } from "./FirstRunGate.logic";
import { SquadronCreateForm } from "./SquadronCreateForm";

export function SquadronFirstRunGate({
  children,
  state,
}: {
  readonly children: ReactNode;
  readonly state: SquadronFirstRunGateState;
}) {
  if (state === "ready") return children;

  const content =
    state === "loading"
      ? {
          title: "Loading Squadrons…",
          description: "Checking which Squadron can give your next agent a home.",
        }
      : state === "requires_creation"
        ? {
            title: "Create your first Squadron",
            description:
              "Agents need a Squadron home. Give this work a name and choose one folder.",
          }
        : {
            title: "Squadron setup is unavailable",
            description:
              "This environment cannot yet load Squadrons, so it cannot create an agent without a home.",
          };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">{content.title}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {content.description}
          </EmptyDescription>
          {state === "requires_creation" ? <SquadronCreateForm /> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
