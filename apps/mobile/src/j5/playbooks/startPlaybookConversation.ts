import { StackActions, useNavigation } from "@react-navigation/native";
import {
  ensurePlaybookAuthor,
  PLAYBOOK_AUTHOR_ID,
  PLAYBOOK_AUTHOR_PROMPT,
  playbookWorkspaces,
} from "@t3tools/client-runtime/j5/playbooks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { selectDraftAgent } from "../agents/agentDraftState";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { preparePlaybookDraft } from "./preparePlaybookDraft";

/**
 * Opens upstream's new chat on a prepared draft, so the person picks the project from its heading.
 * Prepare chat fills "Start playbook <name>"; Create picks Playbook Author and its opening prompt.
 */
export function useStartPlaybookConversation(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const serverConfigs = useServerConfigs();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const readAuthor = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  const editAuthor = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  return async (input: {
    readonly playbook: string | null;
    readonly projects: Parameters<typeof playbookWorkspaces>[0];
    /** The project Settings is showing, so a project playbook's chat opens where it lives. */
    readonly projectId: ProjectId | null;
  }) => {
    const workspaces = playbookWorkspaces(input.projects, []);
    const workspace =
      workspaces.find((entry) => entry.projectId === input.projectId) ?? workspaces[0];
    if (!workspace)
      throw new Error(
        "Add a project to open a conversation. You can import playbooks without one.",
      );
    if (input.playbook === null)
      await ensurePlaybookAuthor({
        providers: serverConfigs.get(environmentId)?.providers ?? [],
        readCatalog: async () => {
          const result = await readCatalog({ environmentId, input: {} });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readDefinition: async (personaId) => {
          const result = await readAuthor({ environmentId, input: { personaId } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value.definition;
        },
        editPersona: async (edit) => {
          const result = await editAuthor({ environmentId, input: edit });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        createPersona: async (definition) => {
          const result = await createPersona({ environmentId, input: definition });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      });
    const draftId = preparePlaybookDraft(
      workspace,
      input.playbook === null ? PLAYBOOK_AUTHOR_PROMPT : `Start playbook ${input.playbook}`,
    );
    if (input.playbook === null) selectDraftAgent(draftId, PLAYBOOK_AUTHOR_ID);
    navigation.dispatch(
      StackActions.push("Thread", {
        draft: {
          environmentId,
          projectId: workspace.projectId,
          title: workspace.title,
          draftId,
        },
      }),
    );
  };
}
