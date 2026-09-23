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
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
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

export function PlaybookLibrarySettings() {
  const { environments } = useEnvironments();
  const workspaces = playbookWorkspaces(useProjects(), useThreadShells());
  const [workspaceKey, setWorkspaceKey] = useState("");
  const workspace = workspaces.find((entry) => entry.key === workspaceKey) ?? workspaces[0];
  const { squadrons, status: squadronStatus } = useSquadronDirectory();
  const authorSquadrons = workspace ? playbookAuthorSquadrons(workspace, squadrons) : [];
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
    <SettingsPageContainer>
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
      <SettingsSection title="Playbooks" id="playbooks" hideTitle variant="plain">
        <div className="flex flex-col gap-3 px-3 pb-3 sm:flex-row sm:items-start sm:justify-between sm:px-4">
          <p className="min-w-0 text-sm text-muted-foreground">
            Reusable prompts that guide an agent through ordered phases. Create and refine them in a
            conversation.
          </p>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <Button
              size="xs"
              disabled={
                !workspace || !authorSquadron?.available || busy || !query.data || !!query.error
              }
              onClick={() => void createPlaybook()}
            >
              Create playbook
            </Button>
            <Button
              size="xs"
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
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Refresh playbooks"
                    disabled={!workspace || busy || query.isPending}
                    onClick={refresh}
                  >
                    <RefreshCwIcon aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipPopup>Refresh playbooks</TooltipPopup>
            </Tooltip>
          </div>
        </div>
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
            <select
              aria-label="Playbook workspace"
              value={workspace?.key ?? ""}
              disabled={busy}
              onChange={(event) => {
                setRenameTarget(null);
                setWorkspaceKey(event.target.value);
                setError(null);
              }}
              className="w-full rounded-md border border-input bg-background p-2 text-foreground sm:w-72"
            >
              {workspaces.length === 0 && <option value="">No projects available</option>}
              {workspaces.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.title}
                  {environments.length > 1
                    ? ` · ${environments.find((env) => env.environmentId === entry.environmentId)?.label ?? entry.environmentId}`
                    : ""}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Authoring Squadron"
          description="Where the Playbook Author chat starts."
          control={
            <select
              aria-label="Playbook author Squadron"
              value={authorSquadron?.squadron.id ?? ""}
              disabled={!workspace || busy}
              onChange={(event) => {
                if (workspace)
                  setAuthorScope({ workspaceKey: workspace.key, squadronId: event.target.value });
                setError(null);
              }}
              className="w-full rounded-md border border-input bg-background p-2 text-foreground sm:w-72"
            >
              <option value="">
                {squadronStatus === "loading"
                  ? "Loading Squadrons…"
                  : authorSquadrons.length === 0
                    ? "No Squadron available for this workspace"
                    : "Choose a Squadron"}
              </option>
              {authorSquadrons.map((entry) => (
                <option
                  key={entry.squadron.id}
                  value={entry.squadron.id}
                  disabled={!entry.available}
                >
                  {entry.squadron.name}
                  {entry.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          }
        />
        <div className="space-y-4 px-3 py-3 sm:px-4">
          {(error || query.error) && !renameTarget && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? query.error}
            </p>
          )}
          {!workspace && (
            <p className="text-sm text-muted-foreground">
              Connect an environment and add a project to create playbooks.
            </p>
          )}
          {query.isPending && !query.data && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading playbooks…
            </p>
          )}
          {query.data?.playbooks.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No playbooks in this workspace yet. Import a YAML file or create one with your agent.
            </p>
          )}
          {query.data?.playbooks.map((playbook) => (
            <article key={playbook.name} className="border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {renameTarget?.name === playbook.name ? (
                    <form
                      className="flex max-w-xl items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitRename();
                      }}
                    >
                      <Input
                        nativeInput
                        autoFocus
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
                      <Button size="xs" type="submit" disabled={busy || !renameTarget.title.trim()}>
                        Save
                      </Button>
                      <Button
                        size="xs"
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setRenameTarget(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <h3 className="font-medium">{playbook.title}</h3>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {playbook.name}.yaml · {playbook.stepCount} phases
                  </p>
                  {renameTarget?.name === playbook.name && (error || query.error) ? (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      {error ?? query.error}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !!query.error || !!playbook.issue}
                    onClick={() => void openDraft(`Start playbook ${playbook.name}`)}
                  >
                    Prepare playbook chat
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !!query.error || !!playbook.issue}
                    onClick={() => {
                      setError(null);
                      setRenameTarget({ name: playbook.name, title: playbook.title });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !!query.error}
                    onClick={() => void removePlaybook(playbook.name)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{playbook.description}</p>
              {playbook.issue ? (
                <p role="status" className="mt-2 text-sm text-destructive">
                  {playbook.issue.message}
                </p>
              ) : (
                <ol
                  className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                  aria-label={`${playbook.title} phases`}
                >
                  {playbook.steps.map((step, index) => (
                    <li key={step.id} className="min-w-0 break-words">
                      {index + 1}. {step.title}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
