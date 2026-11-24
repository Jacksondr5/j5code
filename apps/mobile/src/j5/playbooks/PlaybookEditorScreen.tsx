import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { useAtomCommand } from "../../state/use-atom-command";
import { FormTextRow } from "../agents/PersonaFormRows";
import {
  SettingsFormScreen,
  useSettingsFormExit,
  useSettingsFormParams,
} from "../agents/SettingsFormScreen";
import { j5Environment } from "../state";

const TITLES = { import: "Import playbook", copy: "Copy playbook", rename: "Rename playbook" };
const ACTIONS = { import: "Import", copy: "Copy", rename: "Save" };

/** Import a playbook from YAML, copy one under a new name, or rename one. */
export function PlaybookEditorScreen() {
  const props = useSettingsFormParams<"SettingsPlaybookEditor">();
  const { mode } = props;
  const scope = props.projectId === undefined ? {} : { projectId: props.projectId };
  const initialText = mode.kind === "rename" ? mode.title : mode.kind === "copy" ? mode.name : "";
  const [text, setText] = useState(initialText);
  const [yaml, setYaml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exit = useSettingsFormExit({
    hasChanges: text !== initialText || yaml !== "",
    saving,
  });
  const destination = mode.kind === "copy" ? mode.destination : props.environmentId;
  const canSave = useAtomValue(j5Environment.savePlaybook.permissionAtom(destination));
  const save = useAtomCommand(j5Environment.savePlaybook, { reportFailure: false });
  const rename = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const ready = canSave && text.trim() !== "" && (mode.kind !== "import" || yaml.trim() !== "");
  async function submit() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    const failure = await (async () => {
      if (mode.kind === "rename") {
        const result = await rename({
          environmentId: props.environmentId,
          input: { ...scope, name: mode.name, source: mode.source, title: text.trim() },
        });
        return result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      }
      let definition = yaml;
      if (mode.kind === "copy") {
        const exported = await exportDefinition({
          environmentId: props.environmentId,
          input: { ...scope, name: mode.name, source: mode.source },
        });
        if (exported._tag === "Failure") return squashAtomCommandFailure(exported);
        definition = exported.value.yaml;
      }
      const result = await save({
        environmentId: destination,
        input: { name: text, yaml: definition },
      });
      return result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    })();
    setSaving(false);
    if (failure !== null) {
      setError(failure instanceof Error ? failure.message : "Playbook action failed.");
      exit.saveFailed();
      return;
    }
    exit.leaveAfterSave();
  }
  return (
    <SettingsFormScreen title={TITLES[mode.kind]} guardBack={exit.guardBack}>
      {mode.kind === "rename" ? null : (
        <Text className="px-2 text-sm text-foreground-muted">
          Available in every project on the environment.
        </Text>
      )}
      <SettingsSection>
        <FormTextRow
          label={mode.kind === "rename" ? "Title" : "Name"}
          placeholder={mode.kind === "rename" ? "Title" : "release-review"}
          autoCapitalize="none"
          value={text}
          disabled={saving}
          onChangeText={setText}
        />
        {mode.kind === "import" ? (
          <FormTextRow
            label="YAML"
            borderTop
            multiline
            tall
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste YAML"
            value={yaml}
            disabled={saving}
            onChangeText={setYaml}
          />
        ) : null}
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label={ACTIONS[mode.kind]}
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!ready}
        onPress={() => void submit()}
      />
    </SettingsFormScreen>
  );
}
