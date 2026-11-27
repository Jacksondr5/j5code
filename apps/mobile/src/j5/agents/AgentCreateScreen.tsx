import { useAtomValue } from "@effect/atom-react";
import {
  agentPersonaIdError,
  agentPersonaIdFromName,
  agentPersonaPolicyDrivers,
  defaultAgentPersonaModelRoute,
} from "@t3tools/client-runtime/j5/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaAccess, AgentPersonaModelEntry } from "@t3tools/contracts";
import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { FormTextRow } from "./PersonaFormRows";
import {
  SettingsFormScreen,
  useSettingsFormExit,
  useSettingsFormParams,
} from "./SettingsFormScreen";

type PersonaDraft = {
  displayName: string;
  id: string;
  idEdited: boolean;
  description: string;
  instructions: string;
  access: AgentPersonaAccess;
  modelRoute: ReadonlyArray<AgentPersonaModelEntry> | null;
  independentReviewer: boolean;
};

/** Author a personal agent; it is stored as an imported definition of this environment. */
export function AgentCreateScreen() {
  const props = useSettingsFormParams<"SettingsPersonaNew">();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  // New personas start on read-only, so prefer a provider that sandboxes it.
  const defaultRoute = defaultAgentPersonaModelRoute(
    providers ?? [],
    agentPersonaPolicyDrivers(catalog.data, "read-only"),
  );
  const modelsLoading = providers == null || (catalog.data === null && catalog.isPending);
  const [startingDraft] = useState<PersonaDraft>(
    props.initial
      ? { ...props.initial, idEdited: true }
      : {
          displayName: "",
          id: "",
          idEdited: false,
          description: "",
          instructions: "",
          access: "read-only",
          modelRoute: null,
          independentReviewer: false,
        },
  );
  const [draft, setDraft] = useState(startingDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exit = useSettingsFormExit({
    hasChanges: JSON.stringify(draft) !== JSON.stringify(startingDraft),
    saving,
  });
  const modelRoute = draft.modelRoute ?? defaultRoute;
  const idError = agentPersonaIdError(draft.id);
  const create = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  // The page may outlive the grant it was opened with, so its action follows the live answer.
  const canCreate = useAtomValue(
    agentPersonaEnvironment.createAgentPersona.permissionAtom(props.environmentId),
  );
  const ready =
    !saving &&
    canCreate &&
    idError === null &&
    draft.displayName.trim() !== "" &&
    draft.description.trim() !== "" &&
    draft.instructions.trim() !== "" &&
    modelRoute !== null;
  async function submit() {
    if (!ready || modelRoute === null) return;
    setSaving(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        id: draft.id,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        access: draft.access,
        modelRoute,
        independentReviewer: draft.independentReviewer,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      exit.saveFailed();
      return;
    }
    catalog.refresh();
    exit.leaveAfterSave();
  }
  return (
    <SettingsFormScreen
      title={props.initial ? "Duplicate persona" : "Create persona"}
      guardBack={exit.guardBack}
    >
      <Text className="px-2 text-sm text-foreground-muted">
        A personal persona for this environment. It joins the library like an import, so you can
        edit, switch off, or remove it later.
      </Text>
      <SettingsSection
        footer={
          draft.id !== "" && idError !== null
            ? idError
            : "Stable identifier used in @persona: mentions. Lowercase letters, digits, hyphens."
        }
      >
        <FormTextRow
          label="Name"
          value={draft.displayName}
          disabled={saving}
          onChangeText={(displayName) =>
            setDraft({
              ...draft,
              displayName,
              id: draft.idEdited ? draft.id : agentPersonaIdFromName(displayName),
            })
          }
        />
        <FormTextRow
          label="ID"
          borderTop
          autoCapitalize="none"
          autoCorrect={false}
          value={draft.id}
          disabled={saving}
          onChangeText={(id) => setDraft({ ...draft, id: id.trim(), idEdited: true })}
        />
      </SettingsSection>
      <SettingsSection footer="Markdown. Instructions describe behavior; the access level below is what is enforced.">
        <FormTextRow
          label="Description"
          multiline
          placeholder="One sentence on what this persona is for."
          value={draft.description}
          disabled={saving}
          onChangeText={(description) => setDraft({ ...draft, description })}
        />
        <FormTextRow
          label="Instructions"
          borderTop
          multiline
          tall
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder="# Who this persona is"
          value={draft.instructions}
          disabled={saving}
          onChangeText={(instructions) => setDraft({ ...draft, instructions })}
        />
      </SettingsSection>
      {modelRoute === null ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {modelsLoading
            ? "Loading models…"
            : "Sign in to Codex or Claude on this environment to choose the persona's models."}
        </Text>
      ) : (
        <AgentRoutePolicyFields
          environmentId={props.environmentId}
          value={{
            access: draft.access,
            modelRoute,
            independentReviewer: draft.independentReviewer,
          }}
          disabled={saving}
          onChange={(next) =>
            setDraft({ ...draft, ...next, independentReviewer: next.independentReviewer === true })
          }
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label="Create persona"
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!ready}
        onPress={() => void submit()}
      />
    </SettingsFormScreen>
  );
}
