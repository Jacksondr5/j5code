import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useState } from "react";

import { skillInstallerCommand } from "./skillInstallerCommand";

import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";

const projectKey = (project: EnvironmentProject) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

const folderStorageKey = (environmentId: string) => `j5.skillInstaller.folder:${environmentId}`;

const readStoredFolder = (environmentId: string) => {
  try {
    return window.localStorage.getItem(folderStorageKey(environmentId)) ?? "";
  } catch {
    return "";
  }
};

const storeFolder = (environmentId: string, folder: string) => {
  try {
    if (folder.trim()) window.localStorage.setItem(folderStorageKey(environmentId), folder.trim());
    else window.localStorage.removeItem(folderStorageKey(environmentId));
  } catch {
    // Private browsing or storage limits must not block the installer.
  }
};

export function SkillInstallerSettings() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const openThread = useNewThreadHandler();
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const [selectedKey, setSelectedKey] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const project =
    projects.find((item) => projectKey(item) === selectedKey) ??
    (selectedKey === "" && projects.length === 1 ? projects[0] : undefined);
  const environmentLabel = (id: EnvironmentProject["environmentId"]) =>
    environments.find((item) => item.environmentId === id)?.label ?? id;
  // The folder is chosen once per environment and remembered locally.
  const effectiveFolder =
    folderTouched || !project ? folder : (readStoredFolder(project.environmentId) ?? "");
  const setEffectiveFolder = (value: string) => {
    setFolder(value);
    setFolderTouched(true);
  };
  const platform = project
    ? serverConfigs.get(project.environmentId)?.environment.platform.os
    : undefined;
  const command =
    skillInstallerCommand(effectiveFolder, platform) ?? "node <catalog-folder>/install-skills.mjs";

  async function launch() {
    if (!project || busy || !effectiveFolder.trim()) return;
    setBusy(true);
    setError(null);
    setLaunched(false);
    try {
      storeFolder(project.environmentId, effectiveFolder);
      // A thread hosts the terminal session; no agent message is sent.
      const opened = await openThread(scopeProjectRef(project.environmentId, project.id), {
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      });
      if (!opened) throw new Error("Couldn’t open a terminal host for this project.");
      const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
      const existingIds = selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalIds;
      const terminalId = nextTerminalId(existingIds);
      useTerminalUiStateStore.getState().ensureTerminal(threadRef, terminalId, { open: true });
      const openResult = await openTerminal({
        environmentId: project.environmentId,
        input: {
          threadId: opened.threadId,
          terminalId,
          cwd: project.workspaceRoot,
          env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot } }),
        },
      });
      if (openResult._tag === "Failure") {
        throw new Error("Couldn’t open a terminal on this environment.");
      }
      const writeResult = await writeTerminal({
        environmentId: project.environmentId,
        input: { threadId: opened.threadId, terminalId, data: `${command}\r` },
      });
      if (writeResult._tag === "Failure") {
        throw new Error("Couldn’t start the installer in the terminal.");
      }
      setLaunched(true);
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
        description="Run the catalog wizard in this environment's terminal. No agent chat involved."
      >
        <div className="grid gap-4 p-4">
          <label className="grid gap-2 text-sm">
            Project
            <select
              aria-label="Installer project"
              className="w-full rounded border bg-background p-2"
              disabled={busy || projects.length === 0}
              value={project ? projectKey(project) : ""}
              onChange={(event) => {
                setSelectedKey(event.target.value);
                setFolder("");
                setFolderTouched(false);
                setError(null);
                setLaunched(false);
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
            Catalog folder
            <Input
              value={effectiveFolder}
              disabled={busy || !project}
              placeholder="/path/to/agent-skills"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => {
                setEffectiveFolder(event.target.value);
                setLaunched(false);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            A folder containing catalog.yaml and install-skills.mjs. Remembered for this
            environment.
          </p>
          <p aria-live="polite" className="rounded border bg-muted/50 p-2 font-mono text-xs">
            {command}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy || !project} onClick={() => setPicking(true)}>
              Browse folders
            </Button>
            <Button
              disabled={busy || !project || !effectiveFolder.trim()}
              onClick={() => void launch()}
            >
              {busy ? "Opening…" : "Open installer"}
            </Button>
          </div>
          {launched ? (
            <p role="status" className="text-sm text-muted-foreground">
              Installer running in the thread terminal. Select groups with Space, confirm once, and
              read the result there.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The wizard preselects core, Atlassian, and Dynatrace groups, resolves dependencies,
            previews additions and removals, and applies after one confirmation. Run it again to
            change the selection, check for updates, update the catalog, or uninstall.
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
            setEffectiveFolder(path);
            setLaunched(false);
            setPicking(false);
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
