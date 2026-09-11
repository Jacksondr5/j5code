import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { AgentImportConflictSelection } from "./AgentImportConflictSelection";
import { AgentCreateDialog } from "./AgentCreateDialog";
import {
  agentPersonaDuplicateDraft,
  type AgentPersonaCreateDraft,
} from "@t3tools/client-runtime/j5/agent-personas";
import { AgentEditorDialog } from "./AgentEditorDialog";
import {
  ChevronDownIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  agentPersonaFolderNudges,
  agentPersonaFolderStatusLabel,
  agentPersonaUsageById,
  prepareAgentPersonaImport,
  importAgentPersonasWithConfirmation,
  presentAgentPersonaCatalog,
  presentAgentPersonaUsage,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaEditInput,
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
  EnvironmentId,
} from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";

export function AgentLibrarySettings() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedEnvironments = useMemo(
    () =>
      environments.toSorted((left, right) => {
        const leftPrimary = left.environmentId === primaryEnvironmentId;
        const rightPrimary = right.environmentId === primaryEnvironmentId;
        return Number(rightPrimary) - Number(leftPrimary) || left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = orderedEnvironments.some(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
    ? selectedEnvironmentId
    : (orderedEnvironments[0]?.environmentId ?? null);
  const selectedEnvironment = orderedEnvironments.find(
    (environment) => environment.environmentId === effectiveEnvironmentId,
  );
  const catalog = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.catalog({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const usage = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.usage({ environmentId: effectiveEnvironmentId, input: {} }),
  );
  const usageById = useMemo(() => agentPersonaUsageById(usage.data), [usage.data]);
  const librarySources = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.librarySources({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const availableEditors =
    useServerConfigs().get(effectiveEnvironmentId ?? ("" as EnvironmentId))?.availableEditors ?? [];
  const openInEditor = useOpenInPreferredEditor(effectiveEnvironmentId, availableEditors);
  const setLibraryFolders = useAtomCommand(agentPersonaEnvironment.setLibraryFolders, {
    reportFailure: false,
  });
  const [newFolder, setNewFolder] = useState("");
  const otherEnvironments = orderedEnvironments.filter(
    (environment) => environment.environmentId !== effectiveEnvironmentId,
  );
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ initial?: AgentPersonaCreateDraft } | null>(null);
  const [editing, setEditing] = useState<{
    environmentId: EnvironmentId;
    initial: Omit<AgentPersonaEditInput, "instructions">;
  } | null>(null);
  const importAgents = useAtomCommand(agentPersonaEnvironment.importAgentPersonas, {
    reportFailure: false,
  });
  const removeAgent = useAtomCommand(agentPersonaEnvironment.removeAgentPersona, {
    reportFailure: false,
  });
  const restoreAgent = useAtomCommand(agentPersonaEnvironment.restoreSourceAgentPersona, {
    reportFailure: false,
  });
  const readAgent = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  async function confirmReplacement(
    error: AgentPersonaImportConflictError,
  ): Promise<ReadonlyArray<AgentPersonaImportConflict> | null> {
    let selected = error.conflicts;
    const confirmation = requestConfirmDialog(
      "Replace existing agents?",
      { variant: "destructive" },
      {
        confirmLabel: "Import selected",
        content: (
          <AgentImportConflictSelection
            key={JSON.stringify(error.conflicts)}
            error={error}
            onChange={(value) => {
              selected = value;
            }}
          />
        ),
      },
    );
    if (confirmation === undefined)
      throw new Error(
        "The confirmation dialog is unavailable. Please reopen Settings and try again.",
      );
    return (await confirmation) ? selected : null;
  }
  /** Export plus import in one gesture: the target environment validates and resolves ID conflicts. */
  async function copyPersona(
    personaId: string,
    target: { environmentId: EnvironmentId; label: string },
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const { definition, fileName, yaml } = await readDefinition(personaId);
      const result = await importAgentPersonasWithConfirmation(
        [{ name: fileName, content: yaml }],
        async (input) => {
          const response = await importAgents({ environmentId: target.environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        confirmReplacement,
      );
      if (result === null) return;
      toastManager.add({
        type: "success",
        title:
          result.importedIds.length === 0
            ? `${target.label} kept its existing ${definition.displayName}`
            : `Copied ${definition.displayName} to ${target.label}`,
      });
      if (target.environmentId === effectiveEnvironmentId) catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function saveFolders(folders: ReadonlyArray<string>) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await setLibraryFolders({ environmentId, input: { folders } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setNewFolder("");
      librarySources.refresh();
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Library folders not saved",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function openFolder(path: string) {
    const result = await openInEditor(path);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not open folder",
        description: "Sign in to an editor on this environment, or open the path shown above.",
      });
  }
  async function importSelection(files: File[]) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const definitions = await prepareAgentPersonaImport(
        files.map((file) => ({
          name: file.webkitRelativePath || file.name,
          size: file.size,
          text: () => file.text(),
        })),
      );
      const result = await importAgentPersonasWithConfirmation(
        definitions,
        async (input) => {
          const response = await importAgents({ environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        confirmReplacement,
      );
      if (result === null) return;
      toastManager.add({
        type: "success",
        title: `Imported ${result.importedIds.length} agent(s).`,
      });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const setAgentEnabled = useAtomCommand(agentPersonaEnvironment.setImportedAgentPersonaEnabled, {
    reportFailure: false,
  });
  async function toggleAgent(personaId: string, enabled: boolean) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await setAgentEnabled({ environmentId, input: { personaId, enabled } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function removePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await removeAgent({
        environmentId,
        input: { personaId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({ type: "success", title: "Agent removed" });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function readDefinition(personaId: string) {
    if (effectiveEnvironmentId === null) throw new Error("Select an environment first.");
    const result = await readAgent({
      environmentId: effectiveEnvironmentId,
      input: { personaId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  }
  async function duplicatePersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { definition } = await readDefinition(personaId);
      setCreating({ initial: agentPersonaDuplicateDraft(definition) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function exportPersona(personaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { fileName, yaml } = await readDefinition(personaId);
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      toastManager.add({ type: "success", title: `Exported ${fileName}` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function restorePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await restoreAgent({ environmentId, input: { personaId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({ type: "success", title: "Agent restored" });
      catalog.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const personas =
    catalog.data === null || catalog.data === undefined
      ? []
      : presentAgentPersonaCatalog(catalog.data);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agents">
        <SettingsRow
          title="Agent library"
          description="Run Books activate agents from this environment’s library. Edit imported agents here."
        />
        {orderedEnvironments.length > 1 ? (
          <SettingsRow
            title="Environment"
            description="Availability and model routing are resolved by the selected environment."
            control={
              <Select
                disabled={busy}
                value={effectiveEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  const environment = orderedEnvironments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment) setSelectedEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Agent environment">
                  <SelectValue>{selectedEnvironment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {orderedEnvironments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          {...{ webkitdirectory: "" }}
          aria-label="Choose agent folder"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void importSelection(files);
          }}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".yaml,.yml,application/yaml,text/yaml"
          aria-label="Choose agent YAML file"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void importSelection(files);
          }}
        />
      </SettingsSection>

      <SettingsSection
        title="Scoped agents"
        headerAction={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={busy || effectiveEnvironmentId === null}
              onClick={() => setCreating({})}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              Create agent
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button variant="outline" />}
                disabled={busy || effectiveEnvironmentId === null}
              >
                Import
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  disabled={busy || effectiveEnvironmentId === null}
                  onClick={() => fileInput.current?.click()}
                >
                  Agent file
                </MenuItem>
                <MenuItem
                  disabled={busy || effectiveEnvironmentId === null}
                  onClick={() => folderInput.current?.click()}
                >
                  Folder
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      >
        {effectiveEnvironmentId === null ? (
          <SettingsRow
            title={isReady ? "No connected environments" : "Loading environments"}
            description="Connect an environment to inspect its agent library."
          />
        ) : catalog.isPending ? (
          <SettingsRow title="Loading agents" description="Reading the agent library." />
        ) : catalog.error ? (
          <SettingsRow title="Agents unavailable" description={catalog.error} />
        ) : personas.length === 0 ? (
          <SettingsRow
            title="No personas"
            description="This environment’s configured library is empty."
          />
        ) : (
          personas.map((persona) => (
            <SettingsRow
              key={persona.personaId}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span>{persona.displayName}</span>
                  <Badge variant={persona.availability === "available" ? "success" : "outline"}>
                    {persona.availabilityLabel}
                  </Badge>
                  {persona.originLabel ? (
                    persona.origin?.kind === "folder" ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={<Badge variant="outline">{persona.originLabel}</Badge>}
                        />
                        <TooltipPopup className="font-mono">{persona.origin.path}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      <Badge variant="outline">{persona.originLabel}</Badge>
                    )
                  ) : null}
                </span>
              }
              description={
                <>
                  {persona.description}
                  {(() => {
                    const entry = usageById.get(persona.personaId);
                    if (entry === undefined) return null;
                    const summary = presentAgentPersonaUsage(entry);
                    const line = (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {summary.line}
                      </span>
                    );
                    return summary.routes.length === 0 ? (
                      line
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={line} />
                        <TooltipPopup>
                          {summary.routes.map((route) => (
                            <span key={route} className="block">
                              {route}
                            </span>
                          ))}
                        </TooltipPopup>
                      </Tooltip>
                    );
                  })()}
                </>
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  {persona.removed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Restore ${persona.displayName}`}
                      onClick={() => void restorePersona(persona.personaId)}
                    >
                      <Undo2Icon className="size-4" />
                      Restore
                    </Button>
                  ) : (
                    <>
                      {persona.imported ? (
                        <Switch
                          checked={persona.enabled}
                          disabled={busy}
                          aria-label={`Enable ${persona.displayName}`}
                          onCheckedChange={(enabled) =>
                            void toggleAgent(persona.personaId, enabled)
                          }
                        />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || persona.edit === null}
                        aria-label={`Edit ${persona.displayName}`}
                        title={
                          persona.edit
                            ? `Edit ${persona.displayName}`
                            : "Duplicate this agent to edit a copy"
                        }
                        onClick={() => {
                          if (persona.edit && effectiveEnvironmentId)
                            setEditing({
                              environmentId: effectiveEnvironmentId,
                              initial: persona.edit,
                            });
                        }}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    </>
                  )}
                  <Menu>
                    <MenuTrigger
                      disabled={busy}
                      aria-label={`More actions for ${persona.displayName}`}
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <EllipsisVerticalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => void duplicatePersona(persona.personaId)}>
                        Duplicate as personal agent
                      </MenuItem>
                      <MenuItem onClick={() => void exportPersona(persona.personaId)}>
                        Export YAML
                      </MenuItem>
                      {otherEnvironments.length > 0 ? (
                        <MenuSub>
                          <MenuSubTrigger>Copy to environment</MenuSubTrigger>
                          <MenuSubPopup>
                            {otherEnvironments.map((environment) => (
                              <MenuItem
                                key={environment.environmentId}
                                onClick={() =>
                                  void copyPersona(persona.personaId, {
                                    environmentId: environment.environmentId,
                                    label: environment.label,
                                  })
                                }
                              >
                                {environment.label}
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      ) : null}
                    </MenuPopup>
                  </Menu>
                  {persona.removed ? null : (
                    <Button
                      variant="destructive-outline"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Remove ${persona.displayName}`}
                      title={`Remove ${persona.displayName}`}
                      onClick={() => void removePersona(persona.personaId)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>

      {effectiveEnvironmentId !== null ? (
        <SettingsSection
          title="Library sources"
          description="Folders this environment reads YAML definitions from. Paths are on the environment's machine; relative paths resolve from its state directory."
        >
          {librarySources.isPending ? (
            <SettingsRow title="Loading folders" description="Reading the library configuration." />
          ) : librarySources.error ? (
            <SettingsRow title="Folders unavailable" description={librarySources.error} />
          ) : librarySources.data ? (
            <>
              {librarySources.data.folders.length === 0 ? (
                <SettingsRow
                  title="No source folders"
                  description="Only personal and imported agents are available."
                />
              ) : null}
              {librarySources.data.folders.map((folder) => {
                const nudges = agentPersonaFolderNudges(folder.git);
                return (
                  <SettingsRow
                    key={folder.configuredPath}
                    title={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{folder.configuredPath}</span>
                        <Badge variant={folder.exists ? "outline" : "error"}>
                          {agentPersonaFolderStatusLabel(folder)}
                        </Badge>
                      </span>
                    }
                    description={
                      <>
                        {folder.path !== folder.configuredPath ? (
                          <span className="block font-mono text-xs">{folder.path}</span>
                        ) : null}
                        {nudges.map((nudge) => (
                          <span key={nudge} className="block text-warning-foreground">
                            {nudge}
                          </span>
                        ))}
                      </>
                    }
                    control={
                      <div className="flex items-center gap-2">
                        {folder.exists && availableEditors.length > 0 ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            aria-label={`Open ${folder.configuredPath} in editor`}
                            title="Open in editor"
                            onClick={() => void openFolder(folder.path)}
                          >
                            <ExternalLinkIcon className="size-4" />
                          </Button>
                        ) : null}
                        <Button
                          variant="destructive-outline"
                          size="icon-sm"
                          disabled={busy}
                          aria-label={`Stop reading ${folder.configuredPath}`}
                          title="Remove folder from the library"
                          onClick={() =>
                            void saveFolders(
                              (librarySources.data?.folders ?? [])
                                .map(({ configuredPath }) => configuredPath)
                                .filter((candidate) => candidate !== folder.configuredPath),
                            )
                          }
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    }
                  />
                );
              })}
              <SettingsRow
                title="Add folder"
                description={
                  librarySources.data.configured
                    ? "Files are read on every catalog request, so edits and git pulls apply without a restart."
                    : "Bundled examples appear until a folder is configured or the default folder exists. Adding a folder writes agent-personas.json."
                }
                control={
                  <form
                    className="flex w-full items-center gap-2 sm:w-auto"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const folder = newFolder.trim();
                      if (folder === "") return;
                      void saveFolders([
                        ...(librarySources.data?.folders ?? []).map(
                          ({ configuredPath }) => configuredPath,
                        ),
                        folder,
                      ]);
                    }}
                  >
                    <Input
                      value={newFolder}
                      disabled={busy}
                      placeholder="/path/to/team-library"
                      aria-label="Folder path"
                      className="w-full font-mono sm:w-72"
                      onChange={(event) => setNewFolder(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={busy || newFolder.trim() === ""}
                    >
                      Add
                    </Button>
                  </form>
                }
              />
            </>
          ) : null}
        </SettingsSection>
      ) : null}
      {creating && effectiveEnvironmentId ? (
        <AgentCreateDialog
          environmentId={effectiveEnvironmentId}
          {...(creating.initial ? { initial: creating.initial } : {})}
          onClose={() => setCreating(null)}
          onCreated={(displayName) => {
            setCreating(null);
            toastManager.add({ type: "success", title: `Created ${displayName}` });
            catalog.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <AgentEditorDialog
          key={`${editing.environmentId}:${editing.initial.personaId}`}
          {...editing}
          onClose={() => {
            setEditing(null);
            catalog.refresh();
          }}
          onSaved={() => {
            setEditing(null);
            catalog.refresh();
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
