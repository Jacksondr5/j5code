import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type SkillCatalogApplyResult,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SkillInventoryPanel } from "./SkillManagementSettings";
import { skillCatalogEnvironment } from "./skillCatalogAtoms";
import {
  catalogScopeFor,
  extractPartialApplyResult,
  isCatalogActionable,
  isSourceChangedError,
  isSourceSaveable,
  pruneSelectedGroups,
  summarizeApplyResult,
} from "./skillCatalogView";

import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
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
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { openCommandPalette } from "../../commandPaletteBus";

const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);

interface ApplyFailure {
  readonly message: string;
  readonly partial: SkillCatalogApplyResult | null;
}

function upstreamOf(
  status: { readonly git: { readonly upstream: string | null } } | null,
): string | null {
  return status?.git.upstream ?? null;
}

export function SkillInstallerSettings() {
  const { environments } = useEnvironments();
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

  return (
    <SettingsPageContainer width="expanded">
      <SettingsSection title="Skills">
        <div className="grid gap-4 p-4">
          <p className="text-sm text-muted-foreground">
            Install catalog groups and inspect discovered skills in this environment.
          </p>
          {orderedEnvironments.length > 1 ? (
            <label className="grid gap-2 text-sm">
              Environment
              <Select
                value={effectiveEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  const environment = orderedEnvironments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment) setSelectedEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="Skills environment">
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
            </label>
          ) : null}
          {effectiveEnvironmentId === null ? (
            <p className="text-sm text-muted-foreground">
              Connect an environment to manage its skill catalog.
            </p>
          ) : (
            <div key={effectiveEnvironmentId} className="grid min-w-0 gap-6">
              <SettingsSection id="skill-catalog" title="Catalog">
                <div className="grid gap-4 p-4">
                  <SkillCatalogPanel environmentId={effectiveEnvironmentId} />
                </div>
              </SettingsSection>
              <SettingsSection id="installed-skills" title="Installed">
                <div className="grid min-w-0 gap-4 p-4">
                  <SkillInventoryPanel environmentId={effectiveEnvironmentId} />
                </div>
              </SettingsSection>
            </div>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function SkillCatalogPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const configuredSource =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.settings.skillCatalogSource ?? DEFAULT_SERVER_SETTINGS.skillCatalogSource;

  // The query atom is keyed by environment and source, so its cached status
  // always belongs to the acknowledged settings used by Apply and Update.
  const status = useEnvironmentQuery(
    configuredSource
      ? skillCatalogEnvironment.status({
          environmentId,
          input: { expectedSource: configuredSource },
        })
      : null,
  );

  const [draft, setDraft] = useState<string | null>(null);
  const displayedSource = draft ?? configuredSource;
  useEffect(() => {
    if (draft !== null && draft.trim() === configuredSource) setDraft(null);
  }, [draft, configuredSource]);

  const selectionScope = catalogScopeFor(environmentId, configuredSource);
  // Latest identity for in-flight requests: an Apply started on A must not
  // publish its counts into B's panel when another client switches sources
  // mid-operation. Written in the reset effect below (not during render) so
  // it always moves together with the state reset.
  const selectionScopeRef = useRef(selectionScope);
  const [selection, setSelection] = useState<{ scope: string | null; groups: Array<string> }>({
    scope: null,
    groups: [],
  });
  // Prune against the latest known groups so an Update that removes a group
  // cannot leave Apply submitting an unknown one.
  const knownGroups = status.data?.groups ?? [];
  const selectedGroups = pruneSelectedGroups(
    selection.scope === selectionScope ? selection.groups : (status.data?.selectedGroups ?? []),
    knownGroups,
  );

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const [lastApply, setLastApply] = useState<SkillCatalogApplyResult | null>(null);

  // Selections and results belong to one catalog identity. When acknowledged
  // settings move (another client saved A → B, or this panel saved), drop
  // the previous catalog's state so Apply cannot submit groups, counts,
  // or errors from the old source.
  useEffect(() => {
    selectionScopeRef.current = selectionScope;
    setSelection({ scope: null, groups: [] });
    setLastApply(null);
    setApplyFailure(null);
    setNotice(null);
    setSaveError(null);
  }, [selectionScope]);

  // Awaited directly (not via the shared fan-out hook): this key is
  // environment-local, and the save must settle before identity resets.
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const applyGroupsCommand = useAtomCommand(skillCatalogEnvironment.applyGroups, {
    reportFailure: false,
  });
  const updateCatalogCommand = useAtomCommand(skillCatalogEnvironment.updateCatalog, {
    reportFailure: false,
  });

  const sourceMismatch = isSourceChangedError(status.failure);

  async function saveSource() {
    if (busy) return;
    const trimmed = displayedSource.trim();
    if (!isSourceSaveable(displayedSource, configuredSource)) return;
    const originScope = selectionScope;
    setBusy(true);
    setNotice(null);
    setSaveError(null);
    setApplyFailure(null);
    try {
      const result = await persistSettings({
        environmentId,
        input: { patch: { skillCatalogSource: trimmed } },
      });
      if (selectionScopeRef.current !== originScope) return;
      if (result._tag === "Failure") {
        // The draft stays visible against the old settings; actions stay
        // disabled until the displayed source has matching loaded status.
        setSaveError(messageOf(squashAtomCommandFailure(result)));
        return;
      }
      // The status query follows the echoed settings. Actions stay disabled
      // until the new source's status arrives.
      status.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function applySelected() {
    if (!catalogReady) return;
    const originScope = selectionScope;
    setBusy(true);
    setNotice(null);
    setApplyFailure(null);
    try {
      const result = await applyGroupsCommand({
        environmentId,
        input: { expectedSource: configuredSource, groups: selectedGroups },
      });
      // The source moved mid-operation: discard A's counts/conflicts instead
      // of showing them under B.
      if (selectionScopeRef.current !== originScope) return;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        const partial = extractPartialApplyResult(cause) ?? null;
        setApplyFailure({ message: messageOf(cause), partial });
        setLastApply(partial);
      } else {
        setLastApply(result.value);
        setNotice(summarizeApplyResult(result.value));
      }
      status.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function updateCheckout() {
    if (!catalogReady) return;
    const originScope = selectionScope;
    setBusy(true);
    setNotice(null);
    setApplyFailure(null);
    try {
      const result = await updateCatalogCommand({
        environmentId,
        input: { expectedSource: configuredSource },
      });
      if (selectionScopeRef.current !== originScope) return;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setApplyFailure({ message: messageOf(cause), partial: null });
      } else {
        setNotice(`Catalog updated from ${result.value.upstream}.`);
      }
      status.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Actions run only when the input shows the configured source and status
  // has loaded for exactly that source. This keeps a failed save from
  // leaving Apply enabled against the previous source, and keeps an
  // external A → B change from submitting A before B's status arrives.
  const catalogReady = isCatalogActionable({
    busy,
    isPending: status.isPending,
    hasData: status.data !== null,
    displayedSource,
    configuredSource,
  });
  const applyDisabled = !catalogReady;
  const updateDisabled = !catalogReady || upstreamOf(status.data) === null;

  const toggleGroup = (name: string) => {
    if (!catalogReady) return;
    const current = new Set(selectedGroups);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    setSelection({ scope: selectionScope, groups: [...current] });
  };

  const upstream = upstreamOf(status.data);

  return (
    <>
      <label className="grid gap-2 text-sm">
        Catalog source
        <Input
          value={displayedSource}
          disabled={busy}
          placeholder="https://github.com/your-team/skills.git or /path/to/catalog"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => {
            setDraft(event.target.value);
            setNotice(null);
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        A Git URL, cloned into this environment&apos;s state directory on first use, or an absolute
        path on this environment&apos;s machine. Installed skills are links into that folder, so it
        must stay in place. Saved per environment, never synced.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            openCommandPalette({
              open: "add-project",
              sourcePicker: {
                environmentId,
                onSelect: (source) => {
                  if (selectionScopeRef.current !== selectionScope) return;
                  setDraft(source);
                  setNotice(null);
                },
              },
            });
          }}
        >
          Choose source
        </Button>
        <Button
          disabled={busy || !isSourceSaveable(displayedSource, configuredSource)}
          onClick={() => void saveSource()}
        >
          {busy ? "Saving…" : "Save source"}
        </Button>
        <Button
          variant="outline"
          disabled={busy || displayedSource === DEFAULT_SERVER_SETTINGS.skillCatalogSource}
          title="Clear the catalog source, then save."
          onClick={() => {
            setDraft(DEFAULT_SERVER_SETTINGS.skillCatalogSource);
            setNotice(null);
          }}
        >
          Clear source
        </Button>
        <Button
          variant="outline"
          disabled={busy || updateDisabled}
          title={
            upstream === null
              ? "The catalog reports no upstream to update from."
              : `Update from ${upstream}.`
          }
          onClick={() => void updateCheckout()}
        >
          {busy ? "Updating…" : "Update catalog"}
        </Button>
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {saveError} The previous source is still active.
        </p>
      ) : null}
      {status.error ? (
        <div className="grid gap-2">
          <p role="alert" className="text-sm text-destructive-foreground">
            {status.error}
          </p>
          <div>
            <Button variant="outline" disabled={busy} onClick={() => status.refresh()}>
              {sourceMismatch ? "Reload with current source" : "Retry status"}
            </Button>
          </div>
        </div>
      ) : null}
      {!configuredSource ? (
        <p className="text-sm text-muted-foreground">
          Choose and save a catalog source to get started.
        </p>
      ) : null}
      {configuredSource && status.data === null && !status.error ? (
        <p className="text-sm text-muted-foreground">
          {status.isPending ? "Loading catalog status…" : "No catalog status yet."}
        </p>
      ) : null}
      {status.data ? (
        <>
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              {status.data.catalogDir} · {upstream ?? "no upstream"} ·{" "}
              {status.data.git.dirty ? "dirty" : "clean"}
              {status.data.targets.length > 0
                ? ` · installs to ${status.data.targets.join(", ")}`
                : null}
            </p>
            {status.data.warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted-foreground">
                {warning}
              </p>
            ))}
          </div>
          <fieldset className="grid gap-2" disabled={applyDisabled}>
            <legend className="text-sm font-medium">Groups</legend>
            {status.data.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">This catalog defines no groups.</p>
            ) : null}
            {status.data.groups.map((group) => (
              <div
                key={`${selectionScope}:${group.name}`}
                className="flex items-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  aria-label={`Install ${group.name} group`}
                  className="mt-3"
                  checked={selectedGroups.includes(group.name)}
                  onChange={() => toggleGroup(group.name)}
                />
                <details className="group/skill-group min-w-0 flex-1">
                  <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm py-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground group-open/skill-group:rotate-90"
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-mono">{group.name}</span>
                      {group.description ? (
                        <span className="text-muted-foreground"> — {group.description}</span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {group.skills.length} skills
                        {group.depends.length > 0 ? ` · needs ${group.depends.join(", ")}` : null}
                      </span>
                    </span>
                  </summary>
                  {group.skills.length > 0 ? (
                    <ul className="ml-2 grid gap-3 border-l border-border pb-2 pl-4">
                      {group.skills.map((skill) => (
                        <li key={skill.name} className="min-w-0 break-words">
                          <span className="font-mono text-xs">{skill.name}</span>
                          {skill.description ? (
                            <p className="text-xs text-muted-foreground">{skill.description}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="pb-2 pl-6 text-xs text-muted-foreground">
                      No skills in this group.
                    </p>
                  )}
                </details>
              </div>
            ))}
          </fieldset>
          <div>
            <Button disabled={applyDisabled} onClick={() => void applySelected()}>
              {busy ? "Applying…" : "Apply selected groups"}
            </Button>
          </div>
        </>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {applyFailure ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {applyFailure.message}
          {applyFailure.partial ? ` ${summarizeApplyResult(applyFailure.partial)}` : null}
        </p>
      ) : null}
      {lastApply && (lastApply.conflicts.length > 0 || lastApply.failed.length > 0) ? (
        <div className="grid gap-1 text-sm">
          {lastApply.conflicts.length > 0 ? (
            <p role="alert" className="text-destructive-foreground">
              The conflicting paths were left unchanged. A link may belong to another environment or
              an earlier installation; manage it there to keep using it. To use this catalog
              instead, find the skill under Installed, choose Unlink…, then apply again. Existing
              files or folders must be moved manually.
            </p>
          ) : null}
          {lastApply.conflicts.map((conflict) => (
            <p key={`${conflict.skill}${conflict.linkPath}`} className="break-words">
              Conflict: {conflict.skill} at {conflict.linkPath} — {conflict.detail}
            </p>
          ))}
          {lastApply.failed.map((failed) => (
            <p key={failed.linkPath} className="text-destructive-foreground">
              Failed: {failed.linkPath} — {failed.error}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
