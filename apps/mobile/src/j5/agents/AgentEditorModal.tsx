import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaModelChoices,
  agentPersonaModelChoiceId,
} from "@t3tools/client-runtime/state/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function AgentEditorModal(props: {
  environmentId: EnvironmentId;
  initial: AgentPersonaEditInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const choices = agentPersonaModelChoices(providers ?? [], [
    ...props.initial.modelRoute,
    ...draft.modelRoute,
  ]);
  const save = useAtomCommand(orchestrationEnvironment.v2.editImportedAgentPersona, {
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
            <EditorChoice
              label="Runtime policy"
              value={draft.authorityPolicy}
              disabled={saving}
              choices={AGENT_PERSONA_POLICY_OPTIONS}
              onChange={(value) => {
                const policy = AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === value);
                if (policy) setDraft({ ...draft, authorityPolicy: policy.value });
              }}
            />
            {draft.modelRoute.map((target, index) => {
              const label = index === 0 ? "Primary model" : "Fallback model";
              const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
              const updateTarget = (next: typeof target) =>
                setDraft({
                  ...draft,
                  modelRoute:
                    index === 0 ? [next, draft.modelRoute[1]] : [draft.modelRoute[0], next],
                });
              return (
                <View key={label} className="gap-3 rounded-xl border border-border p-3">
                  <EditorChoice
                    label={label}
                    value={agentPersonaModelChoiceId(target)}
                    disabled={saving}
                    choices={choices.map(({ id, label }) => ({ value: id, label }))}
                    onChange={(value) => {
                      const choice = choices.find(({ id }) => id === value);
                      if (choice)
                        updateTarget({
                          ...choice.target,
                          reasoningEffort: choice.efforts.includes(target.reasoningEffort)
                            ? target.reasoningEffort
                            : choice.target.reasoningEffort,
                        });
                    }}
                  />
                  <EditorChoice
                    label={`${label} reasoning`}
                    value={target.reasoningEffort}
                    disabled={saving}
                    choices={(selected?.efforts ?? []).map((value) => ({ value, label: value }))}
                    onChange={(reasoningEffort) => updateTarget({ ...target, reasoningEffort })}
                  />
                </View>
              );
            })}
            <Text className="text-xs text-foreground-muted">
              Model availability and runtime policy support are checked for each launch.
            </Text>
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

function EditorChoice(props: {
  label: string;
  value: string;
  disabled: boolean;
  choices: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium">{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ expanded, disabled: props.disabled }}
        disabled={props.disabled}
        className="rounded-xl border border-border px-3 py-3"
        onPress={() => setExpanded(!expanded)}
      >
        <Text>
          {props.choices.find(({ value }) => value === props.value)?.label ?? props.value}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 200 }}
          className="rounded-xl border border-border"
        >
          {props.choices.map((choice) => (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: props.value === choice.value }}
              disabled={props.disabled}
              className="border-b border-border-subtle px-3 py-3"
              onPress={() => {
                props.onChange(choice.value);
                setExpanded(false);
              }}
            >
              <Text
                className={
                  props.value === choice.value ? "font-t3-semibold text-primary" : "text-foreground"
                }
              >
                {choice.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
