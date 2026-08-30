import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import type { SquadronFirstRunGateState } from "./FirstRunGate.logic";
import { createSquadron } from "./squadronClient";
import { refreshSquadronDirectory } from "./SquadronDirectory";
import { setAmbientSquadronId } from "./SquadronDraftState";

export function SquadronFirstRunGate({
  children,
  state,
}: {
  readonly children: ReactNode;
  readonly state: SquadronFirstRunGateState;
}) {
  if (state === "ready") return children;

  const content =
    state === "loading"
      ? {
          title: "Loading Squadrons…",
          description: "Checking which Squadron can give your next agent a home.",
        }
      : state === "requires_creation"
        ? {
            title: "Create your first Squadron",
            description:
              "Agents need a Squadron home. Give this work a name and choose one folder.",
          }
        : {
            title: "Squadron setup is unavailable",
            description:
              "This environment cannot yet load Squadrons, so it cannot create an agent without a home.",
          };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">{content.title}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {content.description}
          </EmptyDescription>
          {state === "requires_creation" ? <CreateFirstSquadronForm /> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function CreateFirstSquadronForm() {
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
  const isPrimaryProject = selectedProject?.environmentId === primaryEnvironmentId;
  const nonPrimaryReason =
    selectedProject !== null && !isPrimaryProject
      ? "Squadron creation currently works only for the primary environment. Choose a primary-environment folder; multi-environment routing returns in the next targeting milestone."
      : null;
  const create = useCallback(async () => {
    if (projectId === null || selectedProject === null) {
      setError("Choose one existing folder before creating a Squadron.");
      return;
    }
    if (!isPrimaryProject) {
      setError(
        "This v0 creation path is primary-environment only. Choose a primary-environment folder; multi-environment routing returns in the next targeting milestone.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSquadron({ name, projectId: selectedProject.id });
      setAmbientSquadronId(created.squadron.id);
      await refreshSquadronDirectory({ force: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Squadron.");
    } finally {
      setSubmitting(false);
    }
  }, [isPrimaryProject, name, projectId, selectedProject]);

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
      {nonPrimaryReason !== null ? (
        <p className="text-sm text-destructive">{nonPrimaryReason}</p>
      ) : null}
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button
        disabled={submitting || name.trim().length === 0 || projectId === null || !isPrimaryProject}
        type="submit"
      >
        {submitting ? "Creating…" : "Create Squadron"}
      </Button>
    </form>
  );
}
