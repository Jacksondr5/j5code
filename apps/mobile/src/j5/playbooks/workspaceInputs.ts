import { Atom } from "effect/unstable/reactivity";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";

const workspaceInputsAtom = Atom.make((get) => ({
  projects: get(environmentProjects.projectsAtom),
  threads: get(environmentThreadShells.threadShellsAtom).filter(
    (thread) => thread.deletedAt === null && thread.worktreePath !== null,
  ),
}));

export const playbookWorkspaceInputsAtom = Atom.withEquality(
  workspaceInputsAtom,
  (a, b) =>
    a.projects.length === b.projects.length &&
    a.threads.length === b.threads.length &&
    a.projects.every((project, index) => {
      const previous = b.projects[index];
      return (
        project.environmentId === previous?.environmentId &&
        project.id === previous.id &&
        project.title === previous.title &&
        project.workspaceRoot === previous.workspaceRoot
      );
    }) &&
    a.threads.every((thread, index) => {
      const previous = b.threads[index];
      return (
        thread.environmentId === previous?.environmentId &&
        thread.id === previous.id &&
        thread.projectId === previous.projectId &&
        thread.title === previous.title &&
        thread.worktreePath === previous.worktreePath &&
        thread.branch === previous.branch
      );
    }),
).pipe(Atom.withLabel("mobile-j5:playbook-workspaces"));
