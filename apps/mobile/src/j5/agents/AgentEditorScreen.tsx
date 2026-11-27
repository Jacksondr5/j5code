import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { FormTextRow } from "./PersonaFormRows";
import {
  SettingsFormScreen,
  useSettingsFormExit,
  useSettingsFormParams,
} from "./SettingsFormScreen";

export function AgentEditorScreen() {
  const props = useSettingsFormParams<"SettingsPersonaEdit">();
  const [draft, setDraft] = useState(props.initial);
  // Instructions are not in the catalog; load them once the page opens.
  const [instructions, setInstructions] = useState<string | null>(null);
  const [loadedInstructions, setLoadedInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const exit = useSettingsFormExit({
    hasChanges:
      instructions !== loadedInstructions ||
      JSON.stringify(draft) !== JSON.stringify(props.initial),
    saving,
  });
  // The page may outlive the grant it was opened with, so its action follows the live answer.
  const canSave = useAtomValue(
    agentPersonaEnvironment.editImportedAgentPersona.permissionAtom(props.environmentId),
  );
  const save = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  const read = useAtomCommand(agentPersonaEnvironment.readAgentPersona, {
    reportFailure: false,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the persona's instructions once when the editor opens; the read is a command, not an atom.
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId: props.environmentId, input: { personaId: props.initial.personaId } })
      .then((result) => {
        if (cancelled) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setInstructions(result.value.definition.instructions);
        setLoadedInstructions(result.value.definition.instructions);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.initial.personaId, read]);
  async function submit() {
    if (saving || instructions === null) return;
    setSaving(true);
    setError(null);
    const result = await save({
      environmentId: props.environmentId,
      input: {
        ...draft,
        displayName: draft.displayName.trim(),
        description: draft.description.trim(),
        instructions,
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
    <SettingsFormScreen title="Edit persona" guardBack={exit.guardBack}>
      <Text className="px-2 text-sm text-foreground-muted">
        Changes apply to this imported copy and future launches. The original file and existing
        tasks stay unchanged.
      </Text>
      <SettingsSection>
        <FormTextRow
          label="Name"
          value={draft.displayName}
          disabled={saving}
          onChangeText={(displayName) => setDraft({ ...draft, displayName })}
        />
      </SettingsSection>
      <SettingsSection footer="Markdown. Instructions describe behavior; the access level below is what is enforced.">
        <FormTextRow
          label="Description"
          multiline
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
          placeholder={instructions === null ? "Loading…" : undefined}
          value={instructions ?? ""}
          disabled={saving || instructions === null}
          onChangeText={setInstructions}
        />
      </SettingsSection>
      <AgentRoutePolicyFields
        environmentId={props.environmentId}
        value={draft}
        retainRoute={props.initial.modelRoute}
        disabled={saving}
        onChange={(next) => setDraft({ ...draft, ...next })}
      />
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label="Save changes"
        tone="primary"
        fullWidth
        loading={saving}
        disabled={
          !canSave ||
          instructions === null ||
          !instructions.trim() ||
          !draft.displayName.trim() ||
          !draft.description.trim()
        }
        onPress={() => void submit()}
      />
    </SettingsFormScreen>
  );
}
