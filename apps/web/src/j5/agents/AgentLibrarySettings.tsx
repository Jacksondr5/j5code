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
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  prepareAgentPersonaImport,
  importAgentPersonasWithConfirmation,
  presentAgentPersonaCatalog,
} from "@t3tools/client-runtime/j5/agent-personas";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
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
        async (error) => {
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
        },
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
                </span>
              }
              description={persona.description}
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
