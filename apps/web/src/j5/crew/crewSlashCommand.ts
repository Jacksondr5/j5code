import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * The slash menu entry for `/crew`. It borrows the provider-slash-command item shape so the
 * upstream composer inserts `/crew ` on selection without a new item variant; the brief is then
 * typed after it and the send path launches the Captain. Only a fresh draft can become a Captain,
 * so existing threads do not offer it.
 */
export const j5CrewSlashCommandItems = (provider: ProviderDriverKind, isServerThread: boolean) =>
  isServerThread
    ? []
    : [
        {
          id: "j5:slash:crew",
          type: "provider-slash-command" as const,
          provider,
          command: {
            name: "crew",
            description: "Launch a Crew Captain that proposes a crew for your brief",
          },
          label: "/crew",
          description: "Launch a Crew Captain that proposes a crew for your brief",
        },
      ];
