import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";

import installerInstructions from "../../../../../.agents/skills/j5-install-skills/SKILL.md?raw";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";

const projectKey = (project: EnvironmentProject) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

export function SkillInstallerSettings() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const openThread = useNewThreadHandler();
  const [selectedKey, setSelectedKey] = useState("");
  const [folder, setFolder] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project =
    projects.find((item) => projectKey(item) === selectedKey) ??
    (selectedKey === "" && projects.length === 1 ? projects[0] : undefined);
  const environmentLabel = (id: EnvironmentProject["environmentId"]) =>
    environments.find((item) => item.environmentId === id)?.label ?? id;

  async function launch() {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const opened = await openThread(scopeProjectRef(project.environmentId, project.id), {
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      });
      if (!opened) throw new Error("Couldn’t open an installer chat for this project.");
      const store = useComposerDraftStore.getState();
      // Navigation can race with typing. Never replace work already in the destination draft.
      if (!composerDraftHasUserContent(store.getComposerDraft(opened.draftId))) {
        store.setPrompt(
          opened.draftId,
          [
            "Help me choose and install skill groups for my user on this environment.",
            ...(folder.trim() ? [`Catalog folder: ${JSON.stringify(folder.trim())}`] : []),
            "Follow these installer skill instructions:",
            installerInstructions,
          ].join("\n\n"),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Skills"
        description="Choose shared skill groups and manage your user installation in a guided chat."
      >
        <div className="grid gap-4 p-4">
          <label className="grid gap-2 text-sm">
            Chat project
            <select
              aria-label="Installer project"
              className="w-full rounded border bg-background p-2"
              disabled={busy || projects.length === 0}
              value={project ? projectKey(project) : ""}
              onChange={(event) => {
                setSelectedKey(event.target.value);
                setFolder("");
                setError(null);
              }}
            >
              <option value="" disabled>
                Select a project
              </option>
              {projects.map((item) => (
                <option key={projectKey(item)} value={projectKey(item)}>
                  {item.title} — {environmentLabel(item.environmentId)} — {item.workspaceRoot}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Choose a project on the machine where you want to install skills. The installation
            applies to your user across projects.
          </p>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add a project in a connected environment to open the installer.
            </p>
          ) : null}
          <label className="grid gap-2 text-sm">
            Catalog folder (optional)
            <Input
              value={folder}
              disabled={busy || !project}
              placeholder="/path/to/agent-skills"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setFolder(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            A folder containing catalog.yaml and skills. Leave this blank to choose in chat or reuse
            your previous catalog.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy || !project} onClick={() => setPicking(true)}>
              Browse folders
            </Button>
            <Button disabled={busy || !project} onClick={() => void launch()}>
              {busy ? "Opening…" : "Open installer chat"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send the prepared message, then choose any combination of groups. You can ask the
            installer to list, update, or remove installed groups too.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsSection>
      {picking && project ? (
        <AgentFolderPickerDialog
          environmentId={project.environmentId}
          environmentLabel={environmentLabel(project.environmentId)}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setFolder(path);
            setPicking(false);
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
