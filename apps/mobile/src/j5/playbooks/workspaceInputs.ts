import { samePlaybookWorkspaceInputs } from "@t3tools/client-runtime/j5/playbooks";
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
  samePlaybookWorkspaceInputs,
).pipe(Atom.withLabel("mobile-j5:playbook-workspaces"));
