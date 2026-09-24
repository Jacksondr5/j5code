import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookAuthorSquadrons,
  playbookWorkspaces,
} from "@t3tools/client-runtime/j5/playbooks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { buildThreadRouteParams } from "../../threadRoutes";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";
import { j5Environment } from "../state";
import { playbookImportName } from "./importPlaybookFile";
import { openPlaybookDraft } from "./openPlaybookDraft";

let previousWorkspaces: ReturnType<typeof playbookWorkspaces> = [];
const playbookWorkspacesAtom = Atom.make((get) => {
  const next = playbookWorkspaces(
    get(environmentProjects.projectsAtom),
    get(environmentThreadShells.threadShellsAtom),
  );
  if (
    next.length === previousWorkspaces.length &&
    next.every(
      (workspace, index) =>
        workspace.key === previousWorkspaces[index]?.key &&
        workspace.title === previousWorkspaces[index]?.title &&
        workspace.workspaceRoot === previousWorkspaces[index]?.workspaceRoot &&
        workspace.branch === previousWorkspaces[index]?.branch,
    )
  )
    return previousWorkspaces;
  previousWorkspaces = next;
  return next;
}).pipe(Atom.withLabel("j5-playbook-workspaces"));

export function PlaybookLibrarySettings() {
  const { environments } = useEnvironments();
  const workspaces = useAtomValue(playbookWorkspacesAtom);
  const [workspaceKey, setWorkspaceKey] = useState("");
  const workspace = workspaces.find((entry) => entry.key === workspaceKey) ?? workspaces[0];
  const workspaceItems = workspaces.map((entry) => ({
    value: entry.key,
    label:
      entry.title +
      (environments.length > 1
        ? ` · ${environments.find((env) => env.environmentId === entry.environmentId)?.label ?? entry.environmentId}`
        : ""),
  }));
  const { squadrons, status: squadronStatus } = useSquadronDirectory();
  const authorSquadrons = workspace ? playbookAuthorSquadrons(workspace, squadrons) : [];
  const authorSquadronPlaceholder =
    squadronStatus === "loading"
      ? "Loading Squadrons…"
      : authorSquadrons.length === 0
        ? "No Squadron available for this workspace"
        : "Choose a Squadron";
  const [authorScope, setAuthorScope] = useState<{
    workspaceKey: string;
    squadronId: string;
  } | null>(null);
  const authorSquadron =
    authorScope?.workspaceKey === workspace?.key
      ? authorSquadrons.find(({ squadron }) => squadron.id === authorScope?.squadronId)
      : authorSquadrons.length === 1
        ? authorSquadrons[0]
        : undefined;
  const query = useEnvironmentQuery(
    workspace
      ? j5Environment.playbookLibrary({
          environmentId: workspace.environmentId,
          input: {
            projectId: workspace.projectId,
            ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          },
        })
      : null,
  );
  const { refresh } = query;
  const libraryPath = workspace
    ? `${query.data?.workspaceRoot ?? workspace.workspaceRoot}/.j5/playbooks`
    : null;
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const openThread = useNewThreadHandler();
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const authorStarting = useRef(false);
  const authorLaunch = useRef<{
    workspaceKey: string;
    target: Parameters<typeof startTurn>[0];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const deletePlaybook = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const renamePlaybook = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const [renameTarget, setRenameTarget] = useState<{ name: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function createPlaybook() {
    if (!workspace || !query.data || !authorSquadron?.available || busy || authorStarting.current)
      return;
    authorStarting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { environmentId } = workspace;
      const workspaceKey = JSON.stringify([
        workspace.key,
        query.data.workspaceRoot,
        authorSquadron.squadron.id,
      ]);
      // Retain the command on failure: retrying a lost reply must reopen the same thread.
      if (authorLaunch.current?.workspaceKey !== workspaceKey) {
        const modelSelection = await ensurePlaybookAuthor({
          providers: serverConfigs.get(environmentId)?.providers ?? [],
          readCatalog: async () => {
            const result = await readCatalog({ environmentId, input: {} });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          createPersona: async (input) => {
            const result = await createPersona({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        });
        const createdAt = new Date().toISOString();
        authorLaunch.current = {
          workspaceKey,
          target: playbookAuthorLaunch({
            workspace: { ...workspace, workspaceRoot: query.data.workspaceRoot },
            squadron: authorSquadron,
            modelSelection,
            commandId: CommandId.make(randomUUID()),
            threadId: newThreadId(),
            messageId: newMessageId(),
            createdAt,
          }),
        };
      }
      const { target } = authorLaunch.current;
      const result = await startTurn(target);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const threadRef = scopeThreadRef(environmentId, target.input.threadId);
      const visible = await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentThreadShells.threadShellAtom(threadRef),
        predicate: (thread) => thread !== null,
        timeoutMs: 5_000,
      });
      if (!visible)
        throw new Error(
          "The authoring thread was created but has not synced yet. Choose Create playbook again to reopen it.",
        );
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      authorLaunch.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Playbook Author.");
    } finally {
      authorStarting.current = false;
      setBusy(false);
    }
  }
  async function importFiles(files: File[]) {
    if (!workspace || !query.data || busy || files.length === 0) return;
    setBusy(true);
    setError(null);
    const names = new Set(query.data.playbooks.map((playbook) => playbook.name));
    try {
      for (const file of files) {
        const name = playbookImportName(file.webkitRelativePath || file.name, file.size);
        if (names.has(name) && !window.confirm(`Replace ${name}.yaml?`)) continue;
        const result = await writeFile({
          environmentId: workspace.environmentId,
          input: {
            cwd: query.data.workspaceRoot,
            relativePath: `.j5/playbooks/${name}.yaml`,
            contents: await file.text(),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        names.add(name);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import playbook YAML files.");
    } finally {
      refresh();
      setBusy(false);
    }
  }
  async function removePlaybook(name: string) {
    if (!workspace || !query.data || busy) return;
    if (!window.confirm(`Delete ${name}.yaml from ${workspace.title}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deletePlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete playbook.");
    } finally {
      setBusy(false);
    }
  }
  async function submitRename() {
    if (!workspace || !renameTarget || busy) return;
    const title = renameTarget.title.trim();
    if (!title) return;
    if (title === query.data?.playbooks.find(({ name }) => name === renameTarget.name)?.title) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await renamePlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name: renameTarget.name,
          title,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setRenameTarget(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename playbook.");
    } finally {
      setBusy(false);
    }
  }
  async function openDraft(prompt: string) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      if ((await openPlaybookDraft(workspace, prompt, openThread)) === "preserved")
        toastManager.add({
          type: "info",
          title: "Draft preserved",
          description:
            "Your existing text or attachments are still here. Finish or clear this draft, then choose the playbook action again.",
        });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open a conversation.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".yaml,.yml,application/yaml,text/yaml"
        aria-label="Choose playbook YAML files"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void importFiles(files);
        }}
      />
      <SettingsSection
        title="Playbooks"
        id="playbooks"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={
                !workspace || !authorSquadron?.available || busy || !query.data || !!query.error
              }
              onClick={() => void createPlaybook()}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              Create playbook
            </Button>
            <Button
              variant="outline"
              disabled={!workspace || busy || !query.data || !!query.error}
              onClick={() => fileInput.current?.click()}
            >
              Import YAML
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Refresh playbooks"
                    disabled={!workspace || busy || query.isPending}
                    onClick={refresh}
                  >
                    <RefreshCwIcon aria-hidden="true" className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup>Refresh playbooks</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <SettingsRow
          title="Playbook library"
          description="Reusable prompts that guide an agent through ordered steps. Create and refine them in a conversation."
        />
        <SettingsRow
          title="Workspace"
          description={
            libraryPath && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  {libraryPath}
                </TooltipTrigger>
                <TooltipPopup className="max-w-sm break-all">{libraryPath}</TooltipPopup>
              </Tooltip>
            )
          }
          control={
            <Select
              items={workspaceItems}
              value={workspace?.key ?? null}
              disabled={busy || !workspace}
              onValueChange={(value) => {
                if (value === null) return;
                setRenameTarget(null);
                setWorkspaceKey(value);
                setError(null);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Playbook workspace">
                <SelectValue placeholder="No projects available" />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {workspaceItems.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Authoring Squadron"
          description="Where the Playbook Author chat starts."
          control={
            <Select
              value={authorSquadron?.squadron.id ?? ""}
              disabled={!workspace || busy}
              onValueChange={(value) => {
                if (value === null) return;
                if (workspace) setAuthorScope({ workspaceKey: workspace.key, squadronId: value });
                setError(null);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Playbook author Squadron">
                <SelectValue>
                  {authorSquadron
                    ? `${authorSquadron.squadron.name}${authorSquadron.available ? "" : " (unavailable)"}`
                    : authorSquadronPlaceholder}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="">{authorSquadronPlaceholder}</SelectItem>
                {authorSquadrons.map((entry) => (
                  <SelectItem
                    key={entry.squadron.id}
                    value={entry.squadron.id}
                    disabled={!entry.available}
                  >
                    {entry.squadron.name}
                    {entry.available ? "" : " (unavailable)"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {(error || query.error) && !renameTarget && (
          <SettingsRow
            title={query.error ? "Playbooks unavailable" : "Playbook action failed"}
            status={
              <p role="alert" className="text-destructive">
                {error ?? query.error}
              </p>
            }
          />
        )}
        {!workspace && (
          <SettingsRow
            title="No workspace available"
            description="Connect an environment and add a project to create playbooks."
          />
        )}
        {query.isPending && !query.data && <SettingsRow title="Loading playbooks…" role="status" />}
        {query.data?.playbooks.length === 0 && (
          <SettingsRow
            title="No playbooks in this workspace yet"
            description="Import a YAML file or create one with your agent."
          />
        )}
        {query.data?.playbooks.map((playbook) => (
          <SettingsRow
            key={playbook.name}
            title={playbook.title}
            description={
              <>
                {playbook.description}
                <span className="mt-1 block text-xs">
                  {playbook.name}.yaml · {playbook.stepCount} steps
                </span>
              </>
            }
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!query.error || !!playbook.issue}
                  onClick={() => void openDraft(`Start playbook ${playbook.name}`)}
                >
                  Prepare playbook chat
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Rename ${playbook.title}`}
                  title={`Rename ${playbook.title}`}
                  disabled={busy || !!query.error || !!playbook.issue}
                  onClick={() => {
                    setError(null);
                    setRenameTarget({ name: playbook.name, title: playbook.title });
                  }}
                >
                  <PencilIcon aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="destructive-outline"
                  aria-label={`Delete ${playbook.title}`}
                  title={`Delete ${playbook.title}`}
                  disabled={busy || !!query.error}
                  onClick={() => void removePlaybook(playbook.name)}
                >
                  <Trash2Icon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            }
          >
            <div className="space-y-3 py-2">
              {renameTarget?.name === playbook.name && (
                <form
                  className="flex max-w-xl flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRename();
                  }}
                >
                  <Input
                    nativeInput
                    autoFocus
                    size="sm"
                    className="min-w-0 flex-1 basis-40"
                    aria-label={`Name for ${playbook.name} playbook`}
                    value={renameTarget.title}
                    disabled={busy}
                    onChange={(event) =>
                      setRenameTarget({ ...renameTarget, title: event.currentTarget.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenameTarget(null);
                    }}
                  />
                  <Button size="sm" type="submit" disabled={busy || !renameTarget.title.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setRenameTarget(null)}
                  >
                    Cancel
                  </Button>
                </form>
              )}
              {renameTarget?.name === playbook.name && (error || query.error) ? (
                <p role="alert" className="text-sm text-destructive">
                  {error ?? query.error}
                </p>
              ) : null}
              {playbook.issue ? (
                <p role="status" className="text-sm text-destructive">
                  {playbook.issue.message}
                </p>
              ) : (
                <ol
                  className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                  aria-label={`${playbook.title} steps`}
                >
                  {playbook.steps.map((step, index) => (
                    <li key={step.id} className="min-w-0 break-words">
                      {index + 1}. {step.title}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  );
}
