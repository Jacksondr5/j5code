import { useState } from "react";
import { resolveSkillCatalogGroups, type EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentFolderPickerDialog } from "../agents/AgentFolderPickerDialog";
import { applySkillGroups, skillCatalog } from "./skillCatalogAtoms";

function EnvironmentSkills({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const [folder, setFolder] = useState<string>();
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlyArray<string> | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = useEnvironmentQuery(
    skillCatalog({ environmentId, input: folder === undefined ? {} : { folder } }),
  );
  const apply = useAtomCommand(applySkillGroups, { reportFailure: false });
  const current = catalog.data;
  const folderValue = folderDraft ?? current?.folder ?? "";
  const selected = selection ?? current?.selectedGroups ?? [];
  const available = current?.groups ?? [];
  const missing = selected.filter((id) => !available.some((group) => group.id === id));
  const resolved = resolveSkillCatalogGroups(
    available,
    selected.filter((id) => !missing.includes(id)),
  );
  const included = new Set(resolved.map((group) => group.id));
  const count = new Set(resolved.flatMap((group) => group.skills)).size;
  const unloadedFolder = folderDraft !== null && folderDraft.trim() !== (folder ?? current?.folder);

  function load(path: string) {
    const next = path.trim();
    setFolderDraft(next);
    setSelection(null);
    setError(null);
    setMessage(null);
    if (next === folder) catalog.refresh();
    else setFolder(next);
  }

  async function save() {
    if (!current?.folder) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apply({
        environmentId,
        input: { folder: current.folder, groups: selected },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setSelection(result.value.selectedGroups);
      setMessage(
        count === 0
          ? "Catalog skills removed from your user directories."
          : `${count} catalog skills installed for your user on ${label}.`,
      );
      catalog.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="Catalog folder"
        description={`Choose a folder on ${label} containing catalog.yaml and a skills directory.`}
      >
        <div className="grid gap-3 p-4">
          <label className="grid gap-2 text-sm">
            Folder path
            <Input
              value={folderValue}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="/path/to/agent-skills"
              onChange={(event) => setFolderDraft(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setPicking(true)}>
              Browse folders
            </Button>
            <Button
              variant="outline"
              disabled={busy || !folderValue.trim() || catalog.isPending}
              onClick={() => load(folderValue)}
            >
              {catalog.isPending ? "Loading…" : "Load catalog"}
            </Button>
          </div>
          {catalog.error ? (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
              {catalog.error}
            </p>
          ) : null}
        </div>
      </SettingsSection>
      {current?.folder && !catalog.error ? (
        <SettingsSection
          title="Skill groups"
          description="Select any number of groups. Required groups are included automatically. These skills are available across projects for the user running this environment."
        >
          {available.map((group) => {
            const required = included.has(group.id) && !selected.includes(group.id);
            return (
              <SettingsRow
                key={group.id}
                title={group.id}
                description={
                  <>
                    <span>{group.description}</span>
                    {required ? (
                      <span className="mt-1 block">Included by another selected group.</span>
                    ) : null}
                  </>
                }
                status={
                  <details>
                    <summary className="cursor-pointer">{group.skills.length} skills</summary>
                    <span className="mt-1 block font-mono text-xs">{group.skills.join(", ")}</span>
                  </details>
                }
                control={
                  <Checkbox
                    aria-label={group.id}
                    checked={included.has(group.id)}
                    disabled={busy || required}
                    onCheckedChange={(checked) => {
                      setSelection(
                        checked
                          ? [...selected, group.id]
                          : selected.filter((id) => id !== group.id),
                      );
                      setMessage(null);
                    }}
                  />
                }
              />
            );
          })}
          {missing.map((id) => (
            <SettingsRow
              key={id}
              title={id}
              description="This selected group is no longer in the catalog. Remove it before applying."
              control={
                <Checkbox
                  aria-label={`Remove unavailable group ${id}`}
                  checked
                  disabled={busy}
                  onCheckedChange={() => setSelection(selected.filter((name) => name !== id))}
                />
              }
            />
          ))}
          <div className="grid gap-3 p-4">
            <p className="text-sm">{count} skills selected, including required groups.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || catalog.isPending || unloadedFolder || missing.length > 0}
                onClick={() => void save()}
              >
                {busy ? "Applying…" : "Apply selection"}
              </Button>
              <Button
                variant="outline"
                disabled={busy || selected.length === 0}
                onClick={() => {
                  setSelection([]);
                  setMessage(null);
                }}
              >
                Clear selection
              </Button>
            </div>
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
            {message ? (
              <p role="status" className="text-sm">
                {message}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Existing skills and provider overrides are preserved. Refresh the provider's skills or
              start a new agent session after applying.
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">User skill directories</summary>
              {current.targets.map((path) => (
                <p key={path} className="mt-1 break-all font-mono">
                  {path}
                </p>
              ))}
            </details>
          </div>
        </SettingsSection>
      ) : null}
      {picking ? (
        <AgentFolderPickerDialog
          environmentId={environmentId}
          environmentLabel={label}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            load(path);
          }}
        />
      ) : null}
    </>
  );
}

export function SkillCatalogSettings() {
  const { environments, isReady } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(primary);
  const environment =
    environments.find((item) => item.environmentId === selected) ??
    environments.find((item) => item.environmentId === primary) ??
    environments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Skills"
        description="Install skill groups from a local catalog into your global user configuration."
      >
        {environments.length > 1 ? (
          <SettingsRow
            title="Environment"
            description="The catalog and installed skills live on this environment's machine."
            control={
              <Select
                value={environment?.environmentId}
                onValueChange={(value) => {
                  const next = environments.find((item) => item.environmentId === value);
                  if (next) setSelected(next.environmentId);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Skills environment">
                  <SelectValue>{environment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((item) => (
                    <SelectItem key={item.environmentId} value={item.environmentId}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        {!environment ? (
          <p className="p-4 text-sm text-muted-foreground">
            {isReady ? "Connect an environment to manage its skills." : "Loading environments…"}
          </p>
        ) : null}
      </SettingsSection>
      {environment ? (
        <EnvironmentSkills
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
