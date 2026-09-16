import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * The slash menu entry for `/crew`. It borrows the provider-slash-command item shape so the
 * upstream composer inserts `/crew ` on selection without a new item variant; the brief is then
 * typed after it and the send path wraps it in the crew guidance. Any thread, fresh or running,
 * can compose a Crew, so every composer offers it.
 */
export const j5CrewSlashCommandItems = (provider: ProviderDriverKind) => [
  {
    id: "j5:slash:crew",
    type: "provider-slash-command" as const,
    provider,
    command: {
      name: "crew",
      description: "Ask this thread's agent to propose a crew for your brief",
    },
    label: "/crew",
    description: "Ask this thread's agent to propose a crew for your brief",
  },
];
