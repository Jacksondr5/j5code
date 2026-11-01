import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * Every place an upstream-owned mobile file reaches J5 code (FORK.md "Mobile
 * seams"). An upstream advance that rewrites one of these files can drop the
 * J5 call without a type error; this test fails instead and names the FORK
 * record to re-apply. Add a row whenever a new mobile seam lands.
 */
interface Seam {
  /** Upstream file, relative to `apps/mobile/src`. */
  readonly file: string;
  /** FORK.md or BRANDING.md record that owns the edit. */
  readonly record: string;
  /** J5 module the file must import from. */
  readonly from: string;
  /** Code that must remain in the file: the actual call, render or registration. */
  readonly reaches: ReadonlyArray<string>;
}

const SEAMS: ReadonlyArray<Seam> = [
  {
    file: "features/threads/use-composer-command-menu.ts",
    record: "Saved-agent mentions: persona picker",
    from: "../../j5/agents/useAgentMentionPicker",
    reaches: ["useAgentMentionPicker(environmentId", "agentMentionReplacement(item.personaId)"],
  },
  {
    file: "features/threads/use-composer-command-menu.ts",
    record: "case 49: composer playbook picker",
    from: "@t3tools/client-runtime/j5/playbooks",
    reaches: [
      "playbookMenuItems(playbookQuery.data?.playbooks ?? [], trigger, draftMessage)",
      "playbookSelectionText(draftMessage, trigger, item.name)",
    ],
  },
  {
    file: "features/threads/ComposerCommandPopover.tsx",
    record: "Saved-agent mentions: persona picker",
    from: "@t3tools/client-runtime/j5/agent-mentions",
    reaches: ["ReturnType<typeof agentPersonaMentionItems>"],
  },
  {
    file: "features/threads/NewTaskDraftScreen.tsx",
    record: "Saved-agent mentions: draft-as-agent entry point; case 45",
    from: "../../j5/agents/useDraftAgentAssignment",
    reaches: [
      "useDraftAgentAssignment(",
      "agentPersonaAssignment: draftAgent.assignment",
      "<AgentDraftPicker",
      "clearDraftAgent(draftKey)",
      "expandPlaybookPrompt(draft.text.trim())",
    ],
  },
  {
    file: "features/threads/NewTaskDraftScreen.tsx",
    record: "Saved-agent mentions: persona assignment (a draft's route drives the composer)",
    from: "@t3tools/client-runtime/j5/agent-personas",
    reaches: [
      "composerModelSelectionForThread(draftAgent.assignment, draftModelSelection)",
      "composerModelSelectionForThread(draftAgent.assignment, flow.selectedModel)",
    ],
  },
  {
    file: "features/threads/new-task-flow-provider.tsx",
    record: "Saved-agent mentions: draft-as-agent entry point; case 45",
    from: "../../j5/agents/agentDraftState",
    reaches: ["readDraftAgentPersonaId(", "expandPlaybookPrompt(draft.text.trim())"],
  },
  {
    file: "state/threadOutboxDelivery.ts",
    record: "Saved-agent mentions: draft-as-agent entry point",
    from: "../j5/agents/agentDraftState",
    reaches: [
      "selectDraftAgent(draftKey, queuedMessage.creation.agentPersonaId ?? null)",
      "const checksDraftModel = creation.agentPersonaId === undefined;",
    ],
  },
  {
    file: "features/threads/ThreadRouteScreen.tsx",
    record: "case 69: a guest's level on the thread",
    from: "../../j5/sharing/guestAccess",
    reaches: ["useCanOperateThread("],
  },
  {
    file: "state/use-thread-composer-state.ts",
    record: "case 45: playbook text expansion",
    from: "@t3tools/client-runtime/j5/playbooks",
    reaches: ["expandPlaybookPrompt(draft.text.trim())"],
  },
  {
    file: "features/threads/ThreadDetailScreen.tsx",
    record: "case 45: native playbook composer control",
    from: "../../j5/playbooks/PlaybookComposerControl",
    reaches: ["<PlaybookComposerControl", "hasServerThread={"],
  },
  {
    file: "features/threads/ThreadComposer.tsx",
    record:
      "PR #75–#86 role library; saved-agent mentions: handoff artifacts, draft-as-agent; case 49",
    from: "../../j5/agents/AgentPersonaAssignmentControls",
    reaches: [
      "<AgentPersonaAssignmentControls",
      "compact={!compactEditor.isExpanded}",
      "draftKey: composerDraftKey",
      "projectId: props.selectedThread.projectId",
      'composerMenu.trigger.kind === "slash-playbook"',
    ],
  },
  {
    file: "features/threads/ThreadFeed.tsx",
    record: "case 97: Timeline delegate",
    from: "../../j5/a2a/timeline",
    reaches: [
      "resolveJ5FeedMessage(message, props.j5Timeline)",
      "renderJ5TimelineNotice({ message, timestampLabel })",
      "<J5MessageAuthorLine",
      "<J5OpenSenderThread",
      'from "../../j5/a2a/timelineState"',
      "useJ5Timeline(",
      "resolveJ5FeedMessage(entry.message, j5Timeline)",
    ],
  },
  {
    file: "lib/filePreview.test.ts",
    record: "case 97: Timeline delegate",
    from: "",
    reaches: ['vi.mock("../j5/a2a/timelineState"'],
  },
  {
    file: "features/threads/ThreadQueueControl.tsx",
    record: "case 97: Queue-row formatter",
    from: "../../j5/a2a/queuedDelivery",
    reaches: ["useJ5QueuedDeliveryLabel(", "queuedDeliveryLabel(text) ??"],
  },
  {
    file: "features/threads/thread-list-v2-items.tsx",
    record: "Saved-agent mentions: agent identity",
    from: "../../j5/agents/AgentIdentityChip",
    reaches: [
      "<AgentIdentityChip assignment={thread.agentPersonaAssignment} inset={titleTextInset} />",
    ],
  },
  {
    file: "features/settings/SettingsAgentsRouteScreen.tsx",
    record: "PR #75–#86 role library: Personas settings",
    from: "../../j5/agents/AgentLibrarySettingsScreen",
    reaches: ["<AgentLibrarySettingsScreen />"],
  },
  {
    file: "Stack.tsx",
    record: "PR #75–#86 role library: Personas settings",
    from: "./features/settings/SettingsAgentsRouteScreen",
    reaches: ["screen: SettingsAgentsRouteScreen", 'linking: "settings/personas"'],
  },
  {
    file: "features/settings/SettingsRouteScreen.tsx",
    record: "PR #75–#86 role library: Personas settings",
    from: "",
    reaches: ['page("SettingsAgents", "person.2", "Personas")'],
  },
  {
    file: "features/home/useThreadListActions.ts",
    record: "case 21: archive preflight",
    from: "../../j5/archive/confirmArchive",
    reaches: ['action === "archive" && !(await confirmJ5Archive(thread))'],
  },
  {
    file: "App.tsx",
    record: "case 21: archive preflight",
    from: "./j5/archive/ArchiveWarningSheet",
    reaches: ["<ArchiveWarningHost />"],
  },
  {
    file: "Stack.tsx",
    record: "case 98: artifact routes",
    from: "./j5/artifacts/routes",
    reaches: ["...j5ThreadArtifactRoutes(THREAD_LINKING_PREFIX, GLASS_HEADER_OPTIONS)"],
  },
  {
    file: "features/threads/ThreadFeed.tsx",
    record: "case 98: artifact link resolver",
    from: "../../j5/artifacts/artifactLinks",
    reaches: [
      "openArtifactLink(href, artifactLinkContext)",
      "artifactLinkContextMenu(href, props.workspaceRoot)",
      "onArtifactLinkMenuAction(href, actionId, artifactLinkContext)",
    ],
  },
  {
    file: "App.tsx",
    record: "BRANDING.md: mobile OS identity and links",
    from: "../../../scripts/lib/j5-branding.ts",
    reaches: [
      "J5_BRANDING.mobile.production.scheme",
      "J5_BRANDING.mobile.development.scheme",
      "J5_BRANDING.mobile.preview.scheme",
    ],
  },
  {
    file: "features/connection/pairing.ts",
    record: "BRANDING.md: pairing QR handling",
    from: "../../../../../scripts/lib/j5-branding.ts",
    reaches: ["J5_BRANDING.mobile.production.scheme"],
  },
  {
    file: "widgets/AgentActivity.tsx",
    record: "BRANDING.md: Agent Activity widget",
    from: "../../../../scripts/lib/j5-branding.ts",
    reaches: ["J5_BRANDING.mobile.production.scheme"],
  },
  {
    file: "components/CompactBrandTitle.tsx",
    record: "BRANDING.md: user-visible copy and marks",
    from: "../j5/branding/J5Wordmark",
    reaches: ["<J5Wordmark "],
  },
  {
    file: "features/threads/thread-work-log.tsx",
    record: "BRANDING.md: user-visible copy and marks",
    from: "../../j5/branding/J5Wordmark",
    reaches: ["<J5Wordmark "],
  },
];

const readUpstream = (file: string) =>
  NodeFS.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("upstream mobile files still reach J5 code", () => {
  it.each(SEAMS)("$file ($record)", ({ file, from, reaches }) => {
    const source = readUpstream(file);
    if (from !== "") expect(source).toContain(`from "${from}"`);
    for (const code of reaches) expect(source).toContain(code);
  });
});
