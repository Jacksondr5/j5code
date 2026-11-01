import { useAtomValue } from "@effect/atom-react";
import {
  NAME_NOT_USABLE,
  levelLabel,
  nameIsInUse,
  offeredLevel,
} from "@t3tools/client-runtime/j5/sharing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { isPersonName } from "@t3tools/contracts/j5";
import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Sharing } from "./guestAccess";
import { identityCommands, nameToAskAtom } from "./identity";

const SOMEONE_NEW = "new";

/**
 * Asks the name question of the first saved server that needs it. Mounted once, at the root, so
 * it covers every screen until it is answered.
 */
export function NameQuestionHost() {
  const asking = useAtomValue(nameToAskAtom);
  if (asking === null) return null;
  return <NameQuestion key={asking.id} environmentId={asking.id} kind={asking.kind} />;
}

/**
 * "What should people and agents on <server> call you?", asked before a device uses the server
 * (People and access AC5, AC6), as web's `NameDialog` asks it. There is no way to put it off:
 * until it is answered the device reaches nothing there.
 */
function NameQuestion({
  environmentId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: "claim" | "first-owner";
}) {
  const presentation = useAtomValue(environmentPresentations.presentationsAtom).get(environmentId);
  const serverName = presentation?.entry.target.label ?? "this server";
  const claimable = useEnvironmentQuery(
    kind === "claim" ? identityCommands.claimablePeople({ environmentId, input: {} }) : null,
  );
  const claimDevice = useAtomCommand(identityCommands.claimDevice, { reportFailure: false });
  const setFirstOwnerName = useAtomCommand(identityCommands.setFirstOwnerName, {
    reportFailure: false,
  });
  const people = kind === "claim" ? (claimable.data?.people ?? []) : [];
  const [choice, setChoice] = useState<string>(SOMEONE_NEW);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const naming = kind === "first-owner" || choice === SOMEONE_NEW;

  const save = async () => {
    const typed = name.trim();
    if (naming && !isPersonName(typed)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    const result =
      kind === "first-owner"
        ? await setFirstOwnerName({ environmentId, input: { name: typed } })
        : await claimDevice({
            environmentId,
            input:
              choice === SOMEONE_NEW
                ? { kind: "new", name: typed }
                : { kind: "person", personId: choice },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        nameIsInUse(cause)
          ? `Someone on ${serverName} already has that name.`
          : cause instanceof Error && cause.message.trim() !== ""
            ? cause.message
            : "The server did not say why.",
      );
      return;
    }
    // A claimed device's session is ended for renewal, which reconnects it and reads its access
    // again. The first owner keeps their session, so their access is read again here.
    j5Sharing.refreshConnectionAccess(appAtomRegistry, environmentId);
  };

  const nameInput = (label: string) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      autoFocus={kind === "first-owner" || people.length === 0}
      autoCapitalize="words"
      autoCorrect={false}
      maxLength={80}
      value={name}
      editable={!busy}
      returnKeyType="done"
      onSubmitEditing={() => void save()}
      onChangeText={(value) => {
        setName(value);
        setChoice(SOMEONE_NEW);
        setError(null);
      }}
    />
  );

  return (
    // Full screen, so it can't be swiped away: the question can't be put off.
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => {}}>
      {/* Inline flex: on Android a `flex-1` class left this Modal's content zero-height. */}
      <SafeAreaView className="bg-screen" style={{ flex: 1 }}>
        <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 p-5">
            <View className="gap-2">
              <Text accessibilityRole="header" className="text-2xl font-t3-semibold">
                What should people and agents on {serverName} call you?
              </Text>
              {kind === "claim" ? (
                <Text className="text-foreground-muted">
                  This device is paired but the server does not know who it belongs to.
                </Text>
              ) : null}
            </View>
            {people.length > 0 ? (
              <ListSection>
                {people.map((person, index) => {
                  const level = offeredLevel(person.levels);
                  return (
                    <ListChoiceRow
                      key={person.personId}
                      label={person.name}
                      description={level === null ? undefined : levelLabel(level)}
                      selected={choice === person.personId}
                      separated={index > 0}
                      disabled={busy}
                      onPress={() => {
                        setChoice(person.personId);
                        setError(null);
                      }}
                    />
                  );
                })}
                <ListChoiceRow
                  label="Someone new"
                  selected={choice === SOMEONE_NEW}
                  separated
                  disabled={busy}
                  onPress={() => {
                    setChoice(SOMEONE_NEW);
                    setError(null);
                  }}
                />
              </ListSection>
            ) : null}
            {naming ? nameInput(people.length > 0 ? "Someone new" : "Your name") : null}
            {claimable.error === null ? null : (
              <Text className="text-sm text-foreground-muted">
                The people on this server could not be listed: {claimable.error}
              </Text>
            )}
            {error === null ? null : (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            )}
            <Button
              label={busy ? "Saving…" : "Continue"}
              tone="primary"
              fullWidth
              loading={busy}
              disabled={naming && name.trim() === ""}
              onPress={() => void save()}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
