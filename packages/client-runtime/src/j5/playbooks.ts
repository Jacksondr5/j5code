import {
  PLAYBOOK_MAX_BYTES,
  PLAYBOOK_MAX_STEPS,
  type PlaybookProgress,
} from "@t3tools/contracts/j5";
import type {
  AgentPersonaCreateInput,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2AgentPersonaCatalog,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { defaultAgentPersonaModelRoute } from "./agentPersonas.ts";
import type { ScopedManagedSquadron } from "./squadrons.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/shell.ts";

export const PLAYBOOK_AUTHOR_ID = "playbook-author";
export const PLAYBOOK_AUTHOR_INSTRUCTIONS = `You are Playbook Author. Help the user turn a repeatable task into a small, clear agent-led playbook in this thread's workspace.

1. Start by asking what the playbook should accomplish. Clarify the desired result, inputs, constraints, and evidence of success one focused question at a time. Use details already provided instead of asking again.
2. Inspect existing .j5/playbooks definitions and relevant workspace guidance. Propose the smallest useful sequence of steps, then write or refine the definition once the user's intent is clear. Ask before replacing an unrelated existing definition; preserve stable step IDs when editing.
3. Save .j5/playbooks/<name>.yaml relative to this thread's workspace. Use YAML 1.2 with title, description, and steps. Each step has a unique stable id, a title, and a non-empty prompt. Use 1–${PLAYBOOK_MAX_STEPS} steps, no YAML aliases, and at most ${PLAYBOOK_MAX_BYTES / 1024} KiB. For example:

title: Review a change
description: Inspect a change and report evidence.
steps:
  - id: inspect
    title: Inspect
    prompt: Read the change, check its intended behavior, and record findings with evidence.
  - id: report
    title: Report
    prompt: Summarize findings, checks performed, and remaining uncertainty.

Each prompt tells the same agent what work to do, what evidence to retain, and when to advance.
4. Call playbook_list in this thread after writing. Fix reported issues and repeat until the named definition is listed without an issue. If the tool is unavailable, state that runtime validation is still unverified.
5. Report the file path, purpose, and steps. Explain that the user can inspect it in Settings → Personas and send /playbook <name> when ready to run it.

Stay within authoring and validation. Start a run only when the user explicitly asks. Make changes needed for the playbook; leave unrelated workspace files alone.`;

/** Install once in the selected environment; subsequent launches retain the user's edits. */
export async function ensurePlaybookAuthor(input: {
  providers: ReadonlyArray<ServerProvider>;
  readCatalog: () => Promise<OrchestrationV2AgentPersonaCatalog>;
  createPersona: (definition: AgentPersonaCreateInput) => Promise<unknown>;
}) {
  const findAuthor = async () =>
    (await input.readCatalog()).personas.find(({ personaId }) => personaId === PLAYBOOK_AUTHOR_ID);
  let persona = await findAuthor();
  if (!persona) {
    // Workspace-writing personas currently require the Codex sandbox policy.
    const modelRoute = defaultAgentPersonaModelRoute(
      input.providers.filter(({ driver }) => driver === "codex"),
    );
    if (!modelRoute)
      throw new Error(
        "Playbook Author needs an authenticated Codex provider with an available model. Configure one in Settings → Providers for this environment.",
      );
    try {
      await input.createPersona({
        id: PLAYBOOK_AUTHOR_ID,
        displayName: "Playbook Author",
        description: "Helps you design, write, and validate agent-led playbooks.",
        instructions: PLAYBOOK_AUTHOR_INSTRUCTIONS,
        authorityPolicy: "workspace-write",
        modelRoute,
      });
    } catch (cause) {
      // Another client can create it between our catalog read and create request.
      persona = await findAuthor();
      if (!persona) throw cause;
    }
    persona ??= await findAuthor();
  }
  if (!persona || persona.availability.status !== "available")
    throw new Error(
      "Playbook Author is unavailable. Enable or restore it and check its model route in Settings → Personas for this environment.",
    );
  if (persona.defaultAuthorityPolicy !== "workspace-write")
    throw new Error(
      "Playbook Author needs Workspace write authority to save YAML. Update it in Settings → Personas for this environment.",
    );
  return persona.availability.resolvedModelSelection;
}

export function playbookAuthorSquadrons(
  workspace: ReturnType<typeof playbookWorkspaces>[number],
  squadrons: ReadonlyArray<ScopedManagedSquadron>,
) {
  return squadrons.filter(
    (entry) =>
      entry.environmentId === workspace.environmentId &&
      entry.projectIds.length === 1 &&
      entry.projectIds[0] === workspace.projectId,
  );
}

/** Keep the persona, workspace, and explicit Squadron together through the durable launch. */
export function playbookAuthorLaunch(input: {
  workspace: ReturnType<typeof playbookWorkspaces>[number];
  squadron: ScopedManagedSquadron | undefined;
  modelSelection: ModelSelection;
  commandId: CommandId;
  threadId: ThreadId;
  messageId: MessageId;
  createdAt: string;
}) {
  const { workspace, squadron, modelSelection, commandId, threadId, messageId, createdAt } = input;
  if (!squadron?.available || playbookAuthorSquadrons(workspace, [squadron]).length === 0)
    throw new Error("Choose an available Squadron for this workspace before creating a playbook.");
  return {
    environmentId: workspace.environmentId,
    input: {
      commandId,
      threadId,
      createdAt,
      squadronId: squadron.squadron.id,
      message: {
        messageId,
        role: "user",
        text: "Help me create a playbook in this workspace. Start by asking what I want it to accomplish.",
        attachments: [],
      },
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: workspace.projectId,
          title: "Create playbook",
          modelSelection,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: workspace.branch,
          worktreePath: workspace.threadId ? workspace.workspaceRoot : null,
          createdAt,
          agentPersona: { personaId: PLAYBOOK_AUTHOR_ID },
        },
      },
    } satisfies StartThreadTurnInput,
  };
}

export function playbookWorkspaces(
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">
  >,
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "id" | "projectId" | "title" | "worktreePath" | "branch" | "deletedAt"
    >
  >,
) {
  return projects.flatMap((project) => [
    {
      key: `${project.environmentId}:project:${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      threadId: null,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      branch: null,
    },
    ...threads
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id &&
          thread.worktreePath !== null &&
          thread.worktreePath !== project.workspaceRoot,
      )
      .map((thread) => ({
        key: `${project.environmentId}:thread:${thread.id}`,
        environmentId: project.environmentId,
        projectId: project.id,
        threadId: thread.id,
        title: `${project.title} / ${thread.title}`,
        workspaceRoot: thread.worktreePath!,
        branch: thread.branch,
      })),
  ]);
}

type PlaybookWorkspaceInputs = {
  projects: Parameters<typeof playbookWorkspaces>[0];
  threads: Parameters<typeof playbookWorkspaces>[1];
};

/** Ignore shell activity unless a workspace's identity or location changes. */
export function samePlaybookWorkspaceInputs(
  a: PlaybookWorkspaceInputs,
  b: PlaybookWorkspaceInputs,
) {
  return (
    a.projects.length === b.projects.length &&
    a.threads.length === b.threads.length &&
    a.projects.every((project, index) => {
      const previous = b.projects[index];
      return (
        project.environmentId === previous?.environmentId &&
        project.id === previous.id &&
        project.title === previous.title &&
        project.workspaceRoot === previous.workspaceRoot
      );
    }) &&
    a.threads.every((thread, index) => {
      const previous = b.threads[index];
      return (
        thread.environmentId === previous?.environmentId &&
        thread.id === previous.id &&
        thread.projectId === previous.projectId &&
        thread.title === previous.title &&
        thread.worktreePath === previous.worktreePath &&
        thread.branch === previous.branch &&
        thread.deletedAt === previous.deletedAt
      );
    })
  );
}

/** A composer text expansion. The ordinary agent-message path performs the work. */
export function expandPlaybookPrompt(text: string): string {
  return text.replace(
    /^\s*\/playbook(?:[ \t]+([^\r\n]+))?\s*$/i,
    (_match, name: string | undefined) =>
      name?.trim()
        ? `Start playbook ${name.trim()}`
        : "List available playbooks and help me choose one to start.",
  );
}

export function presentPlaybook(run: PlaybookProgress) {
  const current = run.steps.find((step) => step.id === run.currentStepId);
  return {
    status:
      run.status === "active"
        ? run.issue
          ? "Needs attention"
          : "In progress"
        : run.status === "completed"
          ? "Completed"
          : "Cancelled",
    position: run.position === null ? "Step unavailable" : `Step ${run.position} of ${run.total}`,
    currentTitle: current?.title ?? run.currentStepId,
    steps: run.steps.map((step, index) => {
      const state =
        step.id === run.currentStepId
          ? run.status === "active"
            ? "current"
            : "last"
          : run.position === null
            ? "available"
            : index + 1 < run.position
              ? "earlier"
              : "later";
      return {
        ...step,
        state,
        current: state === "current",
        label: {
          current: "Current",
          last: "Last position",
          available: "Available",
          earlier: "Earlier",
          later: "Later",
        }[state],
      } as const;
    }),
  };
}

/** Prioritize active runs with issues within a fetched page without mutating the query's runs. */
export function sortPlaybookRuns(runs: ReadonlyArray<PlaybookProgress>) {
  return [...runs].sort(
    (a, b) =>
      Number(b.status === "active" && !!b.issue) - Number(a.status === "active" && !!a.issue) ||
      Number(b.status === "active") - Number(a.status === "active") ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}
