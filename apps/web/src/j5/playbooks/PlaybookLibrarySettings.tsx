import { useAtomValue } from "@effect/atom-react";
import { playbookStepLabel } from "@t3tools/client-runtime/j5/playbooks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { PLAYBOOK_MAX_BYTES, type PlaybookSource } from "@t3tools/contracts/j5";
import type { EnvironmentId } from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
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
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { playbookImportName } from "./importPlaybookFile";
import { PlaybookConversationDialog } from "./PlaybookConversationDialog";

/** Shares the Personas page's environment selection; there is only one library scope. */
export function PlaybookLibrarySettings({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { environments: connected } = useEnvironments();
  const guests = useGuestEnvironmentIds();
  const environments = connected.filter((entry) => !guests.has(entry.environmentId));
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment ? (
    <PlaybookLibrary
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      environments={environments}
    />
  ) : (
    <SettingsSection title="Playbooks" id="playbooks">
      <SettingsRow title="No environment connected" />
    </SettingsSection>
  );
}

function PlaybookLibrary({
  environmentId,
  label,
  environments,
}: {
  environmentId: EnvironmentId;
  label: string;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const query = useEnvironmentQuery(j5Environment.playbookLibrary({ environmentId, input: {} }));
  const sources = useEnvironmentQuery(j5Environment.playbookSources({ environmentId, input: {} }));
  const canOperate = useAtomValue(j5Environment.savePlaybook.permissionAtom(environmentId));
  const save = useAtomCommand(j5Environment.savePlaybook, { reportFailure: false });
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const rename = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const remove = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{ name: string | null } | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    name: string;
    title: string;
    source: PlaybookSource;
  } | null>(null);
  const folderPaths = (sources.data?.folders ?? []).flatMap((entry) =>
    entry.source.kind === "folder" ? [entry.source.path] : [],
  );
  const detail = query.data?.playbooks.find((entry) => entry.name === details);
  const { refresh } = query;
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      query.refresh();
      sources.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Playbook action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function changeFolders(folders: string[]) {
    const result = await setFolders({ environmentId, input: { folders } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }
  async function copy(playbookName: string, source: PlaybookSource, destination: EnvironmentId) {
    const targetName = window.prompt("Name for the copied playbook", playbookName);
    if (targetName === null) return;
    const exported = await exportDefinition({
      environmentId,
      input: { name: playbookName, source },
    });
    if (exported._tag === "Failure") throw squashAtomCommandFailure(exported);
    const result = await save({
      environmentId: destination,
      input: { name: targetName, yaml: exported.value.yaml },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    toastManager.add({
      type: "success",
      title: "Playbook copied",
      description: "Available across the destination environment. Copies remain independent.",
    });
  }
  return (
    <>
      <SettingsSection
        title="Playbooks"
        id="playbooks"
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canOperate || busy}
              onClick={() => setConversation({ name: null })}
            >
              <PlusIcon className="size-3" />
              Create playbook
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canOperate || busy}
              onClick={() => {
                setError(null);
                setImporting(true);
              }}
            >
              Import YAML
            </Button>
            <Menu>
              <MenuTrigger
                aria-label="Playbook library actions"
                render={<Button size="icon-xs" variant="ghost-muted" />}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  disabled={busy || query.isPending}
                  onClick={() => {
                    query.refresh();
                    sources.refresh();
                  }}
                >
                  <RefreshCwIcon />
                  Refresh
                </MenuItem>
                <MenuItem
                  disabled={!canOperate || busy || !sources.data}
                  onClick={() => setPicking(true)}
                >
                  Add source folder
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      >
        {(error && !importing && !renameTarget) || query.error || sources.error ? (
          <SettingsRow
            title="Playbooks unavailable"
            status={
              <p role="alert" className="text-destructive">
                {error ?? query.error ?? sources.error}
              </p>
            }
          />
        ) : null}
        {query.isPending && !query.data ? (
          <SettingsRow title="Loading playbooks…" role="status" />
        ) : null}
        {query.data?.playbooks.length === 0 ? (
          <SettingsRow
            title="No playbooks yet"
            description="Create a repeatable workflow with your agent, or import a YAML file."
          />
        ) : null}
        {query.data?.playbooks.map((playbook) => {
          const source = playbook.source ?? { kind: "environment" };
          return (
            <SettingsRow
              key={playbook.name}
              title={playbook.title}
              description={playbook.description}
              status={
                <>
                  <span>
                    {playbook.stepCount} {playbook.stepCount === 1 ? "step" : "steps"}
                    {source.kind === "folder" ? " · From source folder" : ""}
                  </span>
                  {playbook.issue ? (
                    <p role="alert" className="text-destructive">
                      {playbook.issue.message}
                    </p>
                  ) : null}
                  {(playbook.warnings ?? []).map((warning) => (
                    <p
                      role="status"
                      key={`${warning.stepId}:${warning.code}`}
                      className="text-warning"
                    >
                      {warning.message}
                    </p>
                  ))}
                </>
              }
              control={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !!playbook.issue}
                    onClick={() => setConversation({ name: playbook.name })}
                  >
                    Prepare chat
                  </Button>
                  <Menu>
                    <MenuTrigger
                      disabled={busy}
                      aria-label={`More actions for ${playbook.title}`}
                      render={<Button size="icon-sm" variant="ghost" />}
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        disabled={!!playbook.issue}
                        onClick={() => setDetails(playbook.name)}
                      >
                        View steps
                      </MenuItem>
                      <MenuItem
                        disabled={!!playbook.issue}
                        onClick={() =>
                          void act(async () => {
                            const result = await exportDefinition({
                              environmentId,
                              input: { name: playbook.name, source },
                            });
                            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                            const url = URL.createObjectURL(
                              new Blob([result.value.yaml], { type: "application/yaml" }),
                            );
                            const anchor = document.createElement("a");
                            anchor.href = url;
                            anchor.download = result.value.fileName;
                            anchor.click();
                            setTimeout(() => URL.revokeObjectURL(url), 30_000);
                          })
                        }
                      >
                        Export YAML
                      </MenuItem>
                      <MenuItem
                        disabled={!canOperate || source.kind === "folder" || !!playbook.issue}
                        onClick={() => {
                          setError(null);
                          setRenameTarget({ name: playbook.name, title: playbook.title, source });
                        }}
                      >
                        {source.kind === "folder"
                          ? "Rename unavailable: edit source folder"
                          : "Rename"}
                      </MenuItem>
                      {source.kind === "folder" ? (
                        <MenuItem
                          disabled={!canOperate || !!playbook.issue}
                          onClick={() => void act(() => copy(playbook.name, source, environmentId))}
                        >
                          Copy to library
                        </MenuItem>
                      ) : null}
                      {environments.length > 1 ? (
                        <MenuSub>
                          <MenuSubTrigger disabled={!!playbook.issue}>
                            Copy to environment
                          </MenuSubTrigger>
                          <MenuSubPopup>
                            {environments
                              .filter((entry) => entry.environmentId !== environmentId)
                              .map((entry) => (
                                <MenuItem
                                  key={entry.environmentId}
                                  onClick={() =>
                                    void act(() => copy(playbook.name, source, entry.environmentId))
                                  }
                                >
                                  {entry.label}
                                </MenuItem>
                              ))}
                          </MenuSubPopup>
                        </MenuSub>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={!canOperate || source.kind === "folder"}
                        onClick={() => {
                          if (window.confirm(`Delete ${playbook.title}?`))
                            void act(async () => {
                              const result = await remove({
                                environmentId,
                                input: { name: playbook.name, source },
                              });
                              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                            });
                        }}
                      >
                        {source.kind === "folder"
                          ? "Delete unavailable: edit source folder"
                          : "Delete"}
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              }
            />
          );
        })}
      </SettingsSection>
      {(sources.data?.folders ?? []).some(
        (entry) => entry.source.kind === "folder" || entry.issue,
      ) ? (
        <SettingsSection title="Playbook sources">
          {sources.data?.folders
            .filter((entry) => entry.source.kind === "folder" || entry.issue)
            .map((entry) => (
              <SettingsRow
                key={entry.path}
                title={entry.source.kind === "folder" ? entry.path : "Environment library"}
                status={
                  entry.issue ? (
                    <p role="alert" className="text-destructive">
                      {entry.issue.message}
                    </p>
                  ) : (
                    "Read-only source"
                  )
                }
                control={
                  entry.source.kind === "folder" ? (
                    <Menu>
                      <MenuTrigger
                        aria-label={`Actions for source ${entry.path}`}
                        render={<Button size="icon-sm" variant="ghost" />}
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem
                          disabled={!canOperate || busy}
                          onClick={() =>
                            void act(() =>
                              changeFolders(
                                folderPaths.filter(
                                  (folder) =>
                                    entry.source.kind !== "folder" || folder !== entry.source.path,
                                ),
                              ),
                            )
                          }
                        >
                          Remove source
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  ) : undefined
                }
              />
            ))}
        </SettingsSection>
      ) : null}
      {picking ? (
        <AgentFolderPickerDialog
          environmentId={environmentId}
          environmentLabel={label}
          title="Add playbook source folder"
          confirmLabel="Add folder"
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            void act(() => changeFolders([...folderPaths, path]));
          }}
        />
      ) : null}
      {conversation ? (
        <PlaybookConversationDialog
          environmentId={environmentId}
          name={conversation.name}
          onClose={() => setConversation(null)}
        />
      ) : null}
      {detail ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDetails(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{detail.title}</DialogTitle>
              <DialogDescription>{detail.description}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <ol className="space-y-2 text-sm">
                {detail.steps.map((step, index) => (
                  <li key={step.id}>{playbookStepLabel(step, index)}</li>
                ))}
              </ol>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDetails(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      {renameTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRenameTarget(null);
          }}
        >
          <DialogPopup>
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const result = await rename({
                    environmentId,
                    input: { ...renameTarget, title: renameTarget.title.trim() },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setRenameTarget(null);
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>Rename playbook</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <Input
                  autoFocus
                  aria-label="Playbook title"
                  value={renameTarget.title}
                  disabled={busy}
                  onChange={(event) =>
                    setRenameTarget({ ...renameTarget, title: event.currentTarget.value })
                  }
                />
                {error ? (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setRenameTarget(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !renameTarget.title.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {importing ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setImporting(false);
          }}
        >
          <DialogPopup>
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const result = await save({ environmentId, input: { name, yaml } });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setImporting(false);
                  setName("");
                  setYaml("");
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>Import playbook</DialogTitle>
                <DialogDescription>
                  Choose a YAML file or paste a definition. It will be available in every project on
                  this environment.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Input
                  type="file"
                  accept=".yaml,.yml"
                  aria-label="Playbook file"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file)
                      void act(async () => {
                        const nextName = playbookImportName(file.name, file.size);
                        const text = await file.text();
                        if (new TextEncoder().encode(text).byteLength > PLAYBOOK_MAX_BYTES)
                          throw new Error("Playbook is too large.");
                        setName(nextName);
                        setYaml(text);
                      });
                  }}
                />
                <div className="space-y-2">
                  <label htmlFor="playbook-import-name" className="text-sm">
                    Name
                  </label>
                  <Input
                    id="playbook-import-name"
                    placeholder="release-review"
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="playbook-import-yaml" className="text-sm">
                    YAML
                  </label>
                  <Textarea
                    id="playbook-import-yaml"
                    value={yaml}
                    disabled={busy}
                    onChange={(event) => setYaml(event.currentTarget.value)}
                  />
                </div>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setImporting(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !canOperate || !name.trim() || !yaml.trim()}
                >
                  Import
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
