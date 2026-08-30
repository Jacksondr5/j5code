import { useCallback, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  PRIMARY_ENVIRONMENT_CREATION_REASON,
  resolveSquadronCreationState,
} from "./SquadronCreate.logic";
import { createSquadron } from "./squadronClient";
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronId } from "./SquadronDraftState";

/** Shared first-run and subsequent-create form: the caller supplies no default selection. */
export function SquadronCreateForm({ onCreated }: { readonly onCreated?: () => void }) {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects],
  );
  const creationState = resolveSquadronCreationState({
    name,
    hasSelectedProject: selectedProject !== null,
    isPrimaryProject: selectedProject?.environmentId === primaryEnvironmentId,
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
      const created = await createSquadron({ name, projectId: selectedProject.id });
      await refreshSquadronDirectory({ force: true });
      setAmbientSquadronId(created.squadron.id);
      onCreated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Squadron.");
    } finally {
      setSubmitting(false);
    }
  }, [creationState, name, onCreated, selectedProject]);

  if (projects.length === 0) {
    return (
      <div className="mt-5 flex flex-col items-center gap-2">
        <p className="text-sm text-muted-foreground">Add a folder before creating its Squadron.</p>
        <Button size="sm" type="button" onClick={() => openCommandPalette({ open: "add-project" })}>
          Add folder
        </Button>
      </div>
    );
  }

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
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger aria-label="Choose one existing folder">
            <SelectValue placeholder="Choose one folder" />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={`${project.environmentId}:${project.id}`} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
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
