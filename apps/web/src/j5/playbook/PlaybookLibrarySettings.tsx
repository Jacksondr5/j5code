import type { PlaybookDefinitionPresentation } from "@j5/playbook-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import {
  initialPlaybookProjectId,
  launchCreatePlaybook,
  projectsForPlaybookEnvironment,
} from "./CreatePlaybookLauncher.logic";
import {
  importPlaybookDefinitions,
  listPlaybookDefinitions,
  removePlaybookDefinition,
  setPlaybookDefinitionEnabled,
} from "./client";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function PlaybookLibrarySettings() {
  const input = useRef<HTMLInputElement>(null);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openThread = useNewThreadHandler();
  const playbookProjects = useMemo(
    () => projectsForPlaybookEnvironment(projects, primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );
  const [definitions, setDefinitions] = useState<readonly PlaybookDefinitionPresentation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const refresh = useCallback(
    () =>
      listPlaybookDefinitions()
        .then(setDefinitions)
        .catch((cause) => setError(errorMessage(cause))),
    [],
  );
  useEffect(() => void refresh(), [refresh]);
  const run = async (operation: () => Promise<readonly PlaybookDefinitionPresentation[]>) => {
    setBusy(true);
    setError(null);
    try {
      setDefinitions(await operation());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const openCreateDialog = () => {
    setSelectedProjectId(initialPlaybookProjectId(playbookProjects));
    setCreateError(null);
    setCreateOpen(true);
  };
  const selectedProject =
    playbookProjects.find((project) => project.id === selectedProjectId) ?? null;
  const createPlaybook = async () => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const store = useComposerDraftStore.getState();
      const opened = await launchCreatePlaybook({
        project: selectedProject,
        openThread,
        draftHasUserContent: (draftId) =>
          composerDraftHasUserContent(store.getComposerDraft(draftId)),
        setPrompt: store.setPrompt,
      });
      if (opened === null) {
        setCreateError("Couldn’t open a new chat for this project.");
      }
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setCreateBusy(false);
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title="Playbooks">
        <SettingsRow
          title="Playbook library"
          description="Import YAML definitions for this environment. Active runs keep their saved definition."
          control={
            <div className="flex gap-2">
              <Button variant="outline" onClick={openCreateDialog}>
                Create Playbook
              </Button>
              <Button disabled={busy} onClick={() => input.current?.click()}>
                Import YAML
              </Button>
            </div>
          }
        />
        <input
          ref={input}
          hidden
          multiple
          type="file"
          accept=".yaml,.yml,application/yaml"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void run(async () => {
              const contents = await Promise.all(
                files.map(async (file) => ({ name: file.name, content: await file.text() })),
              );
              try {
                return await importPlaybookDefinitions(contents);
              } catch (cause) {
                if (!errorMessage(cause).includes("Confirm replacement")) throw cause;
                if (!window.confirm(`${errorMessage(cause)}\n\nReplace the existing definitions?`))
                  return definitions;
                return importPlaybookDefinitions(contents, true);
              }
            });
          }}
        />
        {error ? (
          <p role="alert" className="rounded border border-destructive p-3 text-sm">
            {error}
          </p>
        ) : null}
        {definitions
          .filter((definition) => definition.source !== undefined)
          .map((definition) => (
            <SettingsRow
              key={`${definition.source}:${definition.id}:${definition.hash}`}
              title={definition.title ?? definition.id}
              description={
                definition.diagnostics?.length
                  ? definition.diagnostics.join("\n")
                  : `${definition.description ?? ""} Version ${definition.version}. ${definition.source ?? "shipped"}.`
              }
              control={
                definition.source === "imported" || definition.canRemove ? (
                  <div className="flex gap-2">
                    {definition.source === "imported" ? (
                      <Button
                        disabled={busy}
                        variant="outline"
                        onClick={() =>
                          void run(() =>
                            setPlaybookDefinitionEnabled(
                              definition.id,
                              definition.enabled === false,
                            ),
                          )
                        }
                      >
                        {definition.enabled === false ? "Enable" : "Disable"}
                      </Button>
                    ) : null}
                    {definition.canRemove ? (
                      <Button
                        disabled={busy}
                        variant="outline"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Remove ${definition.title ?? definition.id}? Existing runs and history will be kept. If another definition has the same id, it will become available again.`,
                            )
                          )
                            return;
                          void run(() => removePlaybookDefinition(definition.id));
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : undefined
              }
            />
          ))}
      </SettingsSection>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Create Playbook</DialogTitle>
            <DialogDescription>
              Choose a project with a compatible j5code checkout. The new chat will guide you
              through authoring and validating the YAML.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {playbookProjects.length === 0 ? (
              <p className="rounded border p-3 text-sm text-muted-foreground">
                No projects are available in this environment.
              </p>
            ) : (
              <label className="block text-sm">
                Project
                <select
                  aria-label="Playbook project"
                  className="mt-1 block w-full rounded border bg-background p-2"
                  value={selectedProjectId}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                >
                  <option value="" disabled>
                    Select a project
                  </option>
                  {playbookProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title} — {project.workspaceRoot}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {createError ? (
              <p role="alert" className="rounded border border-destructive p-3 text-sm">
                {createError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={createBusy}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={createBusy || selectedProject === null}
              onClick={() => void createPlaybook()}
            >
              {createBusy ? "Opening…" : "Open Chat"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
