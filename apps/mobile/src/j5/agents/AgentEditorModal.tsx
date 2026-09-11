import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoutePolicyFields } from "./AgentDefinitionFields";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

export function AgentEditorModal(props: {
  environmentId: EnvironmentId;
  initial: AgentPersonaEditInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAtomCommand(agentPersonaEnvironment.editImportedAgentPersona, {
    reportFailure: false,
  });
  async function submit() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await save({
        environmentId: props.environmentId,
        input: {
          ...draft,
          displayName: draft.displayName.trim(),
          description: draft.description.trim(),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      props.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) props.onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-sheet">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="text-xl font-t3-semibold">Edit agent</Text>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={props.onClose}
              className="px-3 py-2"
            >
              <Text>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 px-5 pb-6"
          >
            <Text className="text-sm text-foreground-muted">
              Changes apply to this imported copy and future launches. The original file and
              existing tasks stay unchanged.
            </Text>
            <View className="gap-2">
              <Text>Name</Text>
              <TextInput
                accessibilityLabel="Name"
                value={draft.displayName}
                editable={!saving}
                onChangeText={(displayName) => setDraft({ ...draft, displayName })}
              />
            </View>
            <View className="gap-2">
              <Text>Description</Text>
              <TextInput
                accessibilityLabel="Description"
                multiline
                value={draft.description}
                editable={!saving}
                onChangeText={(description) => setDraft({ ...draft, description })}
              />
            </View>
            <AgentRoutePolicyFields
              environmentId={props.environmentId}
              value={draft}
              retainRoute={props.initial.modelRoute}
              disabled={saving}
              onChange={(next) => setDraft({ ...draft, ...next })}
            />
            {error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={saving || !draft.displayName.trim() || !draft.description.trim()}
              className="items-center rounded-xl bg-primary px-4 py-3 disabled:opacity-40"
              onPress={() => void submit()}
            >
              <Text className="font-t3-semibold text-primary-foreground">
                {saving ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
