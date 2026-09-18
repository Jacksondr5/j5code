import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

import type { DraftId, DraftThreadEnvMode } from "../../composerDraftStore";

export const CREATE_PLAYBOOK_PROMPT =
  "Use the j5-new-playbook skill at .agents/skills/j5-new-playbook/SKILL.md to create a new playbook.";

type PlaybookProject = Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">;

export function projectsForPlaybookEnvironment(
  projects: readonly PlaybookProject[],
  environmentId: EnvironmentId | null,
): readonly PlaybookProject[] {
  return environmentId === null
    ? []
    : projects.filter((project) => project.environmentId === environmentId);
}

export function initialPlaybookProjectId(projects: readonly PlaybookProject[]): string {
  return projects.length === 1 ? (projects[0]?.id ?? "") : "";
}

export async function launchCreatePlaybook(input: {
  readonly project: PlaybookProject | null;
  readonly openThread: (
    projectRef: ReturnType<typeof scopeProjectRef>,
    options: {
      readonly envMode: DraftThreadEnvMode;
      readonly branch: null;
      readonly worktreePath: null;
      readonly startFromOrigin: false;
    },
  ) => Promise<{ readonly draftId: DraftId } | null>;
  readonly draftHasUserContent: (draftId: DraftId) => boolean;
  readonly setPrompt: (draftId: DraftId, prompt: string) => void;
}): Promise<{ readonly draftId: DraftId } | null> {
  if (input.project === null) return null;

  const opened = await input.openThread(
    scopeProjectRef(input.project.environmentId, input.project.id),
    { envMode: "local", branch: null, worktreePath: null, startFromOrigin: false },
  );
  if (opened !== null && !input.draftHasUserContent(opened.draftId)) {
    input.setPrompt(opened.draftId, CREATE_PLAYBOOK_PROMPT);
  }
  return opened;
}
