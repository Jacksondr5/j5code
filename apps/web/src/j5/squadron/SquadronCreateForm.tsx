import { useCallback, useState } from "react";

import { openCommandPalette, type CommandPaletteProjectSelection } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { formatSquadronFolder, resolveSquadronCreationState } from "./SquadronCreate.logic";
import { createSquadron } from "./squadronClient";
import { refreshSquadronDirectory, useSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronScope } from "./SquadronDraftState";

/** Shared first-run and subsequent-create form: the caller supplies no default selection. */
export function SquadronCreateForm({ onCreated }: { readonly onCreated?: () => void }) {
  const { sources } = useSquadronDirectory();
  const [name, setName] = useState("");
  const [selectedProject, setSelectedProject] = useState<CommandPaletteProjectSelection | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = sources.find(
    (source) => source.environmentId === selectedProject?.projectRef.environmentId,
  );
  const creationState = resolveSquadronCreationState({
    name,
    hasSelectedProject: selectedProject !== null,
    environmentAvailable: source?.status === "ready",
    canOperate: source?.canOperate === true,
  });
  const create = useCallback(async () => {
    if (creationState.kind !== "ready" || selectedProject === null) {
      setError(
        creationState.kind === "ready"
          ? "Choose one existing folder before creating a Squadron."
          : creationState.message,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSquadron(selectedProject.projectRef.environmentId, {
        name,
        projectId: selectedProject.projectRef.projectId,
      });
      await refreshSquadronDirectory({
        environmentId: selectedProject.projectRef.environmentId,
        force: true,
      });
      setAmbientSquadronScope({
        environmentId: selectedProject.projectRef.environmentId,
        squadronId: created.squadron.id,
      });
      onCreated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Squadron.");
    } finally {
      setSubmitting(false);
    }
  }, [creationState, name, onCreated, selectedProject]);

  return (
    <form
      className="mt-5 flex w-full max-w-sm flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        Squadron name
        <Input nativeInput value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        Folder
        <div className="flex flex-col gap-2">
          <Button
            aria-label={selectedProject === null ? "Choose folder" : "Change folder"}
            size="sm"
            type="button"
            variant="outline"
            onClick={() =>
              openCommandPalette({ open: "add-project", onProjectSelected: setSelectedProject })
            }
          >
            {selectedProject === null ? "Choose folder" : "Change folder"}
          </Button>
          {selectedProject === null ? (
            <p className="text-sm font-normal text-muted-foreground">Choose one folder.</p>
          ) : (
            <p className="text-sm font-normal text-muted-foreground">
              {formatSquadronFolder(selectedProject)}
              {source !== undefined ? (
                <span className="mt-1 block text-xs">{source.environmentLabel}</span>
              ) : null}
            </p>
          )}
        </div>
      </label>
      {creationState.kind === "environment-unavailable" ||
      creationState.kind === "read-only-environment" ? (
        <p className="text-sm text-destructive">{creationState.message}</p>
      ) : null}
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={submitting || creationState.kind !== "ready"} type="submit">
        {submitting ? "Creating…" : "Create Squadron"}
      </Button>
    </form>
  );
}
