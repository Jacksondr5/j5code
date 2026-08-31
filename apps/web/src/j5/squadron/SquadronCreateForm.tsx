import { useCallback, useState } from "react";

import { openCommandPalette, type CommandPaletteProjectSelection } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  formatSquadronFolder,
  PRIMARY_ENVIRONMENT_CREATION_REASON,
  resolveSquadronCreationState,
} from "./SquadronCreate.logic";
import { createSquadron } from "./squadronClient";
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronId } from "./SquadronDraftState";

/** Shared first-run and subsequent-create form: the caller supplies no default selection. */
export function SquadronCreateForm({ onCreated }: { readonly onCreated?: () => void }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [name, setName] = useState("");
  const [selectedProject, setSelectedProject] = useState<CommandPaletteProjectSelection | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creationState = resolveSquadronCreationState({
    name,
    hasSelectedProject: selectedProject !== null,
    isPrimaryProject: selectedProject?.projectRef.environmentId === primaryEnvironmentId,
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
      const created = await createSquadron({
        name,
        projectId: selectedProject.projectRef.projectId,
      });
      await refreshSquadronDirectory({ force: true });
      setAmbientSquadronId(created.squadron.id);
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
            </p>
          )}
        </div>
      </label>
      {creationState.kind === "non-primary-project" ? (
        <p className="text-sm text-destructive">{PRIMARY_ENVIRONMENT_CREATION_REASON}</p>
      ) : null}
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={submitting || creationState.kind !== "ready"} type="submit">
        {submitting ? "Creating…" : "Create Squadron"}
      </Button>
    </form>
  );
}
