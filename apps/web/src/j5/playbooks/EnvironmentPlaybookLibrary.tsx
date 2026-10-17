import { playbookStepLabel } from "@t3tools/client-runtime/j5/playbooks";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PlaybookSource } from "@t3tools/contracts/j5";
import { useState } from "react";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";
import { useSettingsScopeEnvironments } from "../settingsScopeEnvironment";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";
import { j5Environment } from "../state";

/** Environment content can be managed without selecting or even having a project. */
export function EnvironmentPlaybookLibrary() {
  const { environments: connected } = useEnvironments();
  const guests = useGuestEnvironmentIds();
  const environments = connected.filter((environment) => !guests.has(environment.environmentId));
  const scope = useSettingsScopeEnvironments(environments, usePrimaryEnvironmentId());
  const [selected, setSelected] = useState<EnvironmentId | null>(scope.initialEnvironmentId);
  const environment =
    scope.candidates.find(
      (entry) => entry.environmentId === (scope.pinnedEnvironmentId ?? selected),
    ) ?? scope.candidates[0];
  return (
    <SettingsSection title="Environment playbook library">
      <SettingsRow
        title="Environment"
        description="Playbooks saved here are available across every project and worktree on this environment."
        control={
          <Select
            items={scope.candidates.map((entry) => ({
              value: entry.environmentId,
              label: entry.label,
            }))}
            value={environment?.environmentId ?? null}
            disabled={scope.pinnedEnvironmentId !== null}
            onValueChange={(value) => {
              const found = environments.find((entry) => entry.environmentId === value);
              if (found) setSelected(found.environmentId);
            }}
          >
            <SelectTrigger size="sm" aria-label="Playbook library environment">
              <SelectValue placeholder="No environment connected" />
            </SelectTrigger>
            <SelectPopup>
              {scope.candidates.map((entry) => (
                <SelectItem key={entry.environmentId} value={entry.environmentId}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {environment ? (
        <EnvironmentLibrary
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          environments={environments}
        />
      ) : null}
    </SettingsSection>
  );
}

function EnvironmentLibrary({
  environmentId,
  label,
  environments,
}: {
  environmentId: EnvironmentId;
  label: string;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const [source, setSource] = useState<PlaybookSource>({ kind: "environment" });
  const sources = useEnvironmentQuery(j5Environment.playbookSources({ environmentId, input: {} }));
  const query = useEnvironmentQuery(
    j5Environment.playbookLibrary({ environmentId, input: { source } }),
  );
  const canOperate = useAtomValue(j5Environment.savePlaybook.permissionAtom(environmentId));
  const save = useAtomCommand(j5Environment.savePlaybook, { reportFailure: false });
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const rename = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const remove = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderPaths = (sources.data?.folders ?? []).flatMap((entry) =>
    entry.source.kind === "folder" ? [entry.source.path] : [],
  );
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
  async function copy(playbookName: string, destination: EnvironmentId) {
    const targetName = window.prompt("Name for the copied playbook", playbookName);
    if (targetName === null) return;
    const exported = await exportDefinition({
      environmentId,
      input: { name: playbookName, source },
    });
    if (exported._tag === "Failure") throw squashAtomCommandFailure(exported);
    const saved = await save({
      environmentId: destination,
      input: { name: targetName, yaml: exported.value.yaml },
    });
    if (saved._tag === "Failure") throw squashAtomCommandFailure(saved);
    toastManager.add({
      type: "success",
      title: "Playbook copied",
      description:
        "Available across the destination environment. Future edits to the original are separate.",
    });
  }
  return (
    <>
      <SettingsRow
        title="Library sources"
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                query.refresh();
                sources.refresh();
              }}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy || !sources.data}
              onClick={() => setPicking(true)}
            >
              Add folder
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy}
              onClick={() => setShowSave(!showSave)}
            >
              Save YAML
            </Button>
          </div>
        }
      />
      {picking ? (
        <AgentFolderPickerDialog
          environmentId={environmentId}
          environmentLabel={label}
          title="Add playbook library folder"
          confirmLabel="Add folder"
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            void act(() => changeFolders([...folderPaths, path]));
          }}
        />
      ) : null}
      {error || sources.error || query.error ? (
        <SettingsRow
          title="Playbook library action failed"
          description={error ?? sources.error ?? query.error ?? ""}
        />
      ) : null}
      {sources.isPending && !sources.data ? <SettingsRow title="Loading library sources…" /> : null}
      {sources.data?.folders.map((entry) => (
        <SettingsRow
          key={entry.path}
          title={entry.source.kind === "environment" ? "Environment library" : entry.path}
          description={entry.issue?.message ?? entry.path}
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setSource(entry.source)}
              >
                View
              </Button>
              {entry.source.kind === "folder" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || busy}
                  onClick={() =>
                    void act(async () => {
                      await changeFolders(
                        folderPaths.filter(
                          (path) => entry.source.kind !== "folder" || path !== entry.source.path,
                        ),
                      );
                      setSource({ kind: "environment" });
                    })
                  }
                >
                  Remove folder
                </Button>
              ) : null}
            </div>
          }
        />
      ))}
      {showSave ? (
        <SettingsRow
          title="Save to environment library"
          description="Paste a new playbook definition. Existing names are never replaced."
        >
          <form
            className="space-y-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const result = await save({ environmentId, input: { name, yaml } });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setName("");
                setYaml("");
                setShowSave(false);
                setSource({ kind: "environment" });
              });
            }}
          >
            <Input
              aria-label="New environment playbook name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              disabled={busy}
            />
            <Textarea
              aria-label="Playbook YAML"
              value={yaml}
              onChange={(event) => setYaml(event.currentTarget.value)}
              disabled={busy}
            />
            <Button size="sm" type="submit" disabled={busy || !canOperate || !name || !yaml}>
              Save playbook
            </Button>
          </form>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={source.kind === "folder" ? source.path : "Saved environment playbooks"}
        description={
          source.kind === "folder"
            ? "Edit these files in the source folder, or copy one into the environment library."
            : "Available from every project on this environment."
        }
      />
      {query.isPending && !query.data ? <SettingsRow title="Loading playbooks…" /> : null}
      {query.data?.playbooks.length === 0 ? (
        <SettingsRow title="No playbooks in this source yet" />
      ) : null}
      {query.data?.playbooks.map((playbook) => (
        <SettingsRow
          key={playbook.name}
          title={playbook.title}
          description={playbook.description}
          status={
            <div className="space-y-1">
              <span>
                {playbook.name}.yaml · {playbook.stepCount} steps
              </span>
              {playbook.issue ? (
                <p role="alert" className="text-destructive">
                  {playbook.issue.message}
                </p>
              ) : (
                <ol>
                  {playbook.steps.map((step, index) => (
                    <li key={step.id}>{playbookStepLabel(step, index)}</li>
                  ))}
                </ol>
              )}
              {(playbook.warnings ?? []).map((warning) => (
                <p key={`${warning.stepId}:${warning.code}`} role="status">
                  {warning.message}
                </p>
              ))}
            </div>
          }
          control={
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="outline" />} disabled={busy}>
                Actions
              </MenuTrigger>
              <MenuPopup>
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
                    const title = window.prompt("Playbook title", playbook.title);
                    if (title !== null)
                      void act(async () => {
                        const result = await rename({
                          environmentId,
                          input: { name: playbook.name, title, source },
                        });
                        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      });
                  }}
                >
                  {source.kind === "folder"
                    ? "Rename unavailable: edit the source folder"
                    : "Rename"}
                </MenuItem>
                {source.kind === "folder" ? (
                  <MenuItem
                    disabled={!canOperate || !!playbook.issue}
                    onClick={() => void act(() => copy(playbook.name, environmentId))}
                  >
                    Copy to environment library
                  </MenuItem>
                ) : null}
                <MenuSub>
                  <MenuSubTrigger disabled={!!playbook.issue}>Copy to environment</MenuSubTrigger>
                  <MenuSubPopup>
                    {environments
                      .filter((entry) => entry.environmentId !== environmentId)
                      .map((entry) => (
                        <MenuItem
                          key={entry.environmentId}
                          onClick={() => void act(() => copy(playbook.name, entry.environmentId))}
                        >
                          {entry.label}
                        </MenuItem>
                      ))}
                  </MenuSubPopup>
                </MenuSub>
                <MenuItem
                  disabled={!canOperate || source.kind === "folder"}
                  onClick={() => {
                    if (window.confirm(`Delete ${playbook.name} from this environment?`))
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
                    ? "Delete unavailable: edit the source folder"
                    : "Delete playbook"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          }
        />
      ))}
    </>
  );
}
