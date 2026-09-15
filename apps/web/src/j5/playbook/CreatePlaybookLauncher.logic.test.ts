import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import {
  CREATE_PLAYBOOK_PROMPT,
  initialPlaybookProjectId,
  launchCreatePlaybook,
  projectsForPlaybookEnvironment,
} from "./CreatePlaybookLauncher.logic";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const project = (id: string, environmentId = localEnvironmentId) => ({
  id: ProjectId.make(id),
  environmentId,
  title: id,
  workspaceRoot: `/work/${id}`,
});

describe("Create Playbook launcher", () => {
  it("lists only projects from the Playbooks library environment and selects only a sole project", () => {
    const sole = projectsForPlaybookEnvironment(
      [project("one"), project("remote", remoteEnvironmentId)],
      localEnvironmentId,
    );
    expect(sole.map(({ id }) => id)).toEqual(["one"]);
    expect(initialPlaybookProjectId(sole)).toBe("one");
    expect(initialPlaybookProjectId([...sole, project("two")])).toBe("");
    expect(projectsForPlaybookEnvironment(sole, null)).toEqual([]);
  });

  it("opens the selected checkout in local mode and seeds the returned empty draft", async () => {
    const draftId = DraftId.make("draft-new-playbook");
    const openThread = vi.fn(async () => ({ draftId }));
    const setPrompt = vi.fn();

    await launchCreatePlaybook({
      project: project("j5code"),
      openThread,
      draftHasUserContent: () => false,
      setPrompt,
    });

    expect(openThread).toHaveBeenCalledWith(
      { environmentId: localEnvironmentId, projectId: ProjectId.make("j5code") },
      { envMode: "local", branch: null, worktreePath: null, startFromOrigin: false },
    );
    expect(setPrompt).toHaveBeenCalledWith(draftId, CREATE_PLAYBOOK_PROMPT);
  });

  it("does not overwrite existing user content or open a draft without a selected project", async () => {
    const draftId = DraftId.make("draft-existing-content");
    const openThread = vi.fn(async () => ({ draftId }));
    const setPrompt = vi.fn();

    await launchCreatePlaybook({
      project: project("j5code"),
      openThread,
      draftHasUserContent: () => true,
      setPrompt,
    });
    expect(setPrompt).not.toHaveBeenCalled();

    expect(
      await launchCreatePlaybook({
        project: null,
        openThread,
        draftHasUserContent: () => false,
        setPrompt,
      }),
    ).toBeNull();
    expect(openThread).toHaveBeenCalledTimes(1);
  });
});
