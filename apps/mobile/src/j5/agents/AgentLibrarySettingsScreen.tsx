import { AgentLibraryToast, type AgentLibraryNotification } from "./AgentLibraryToast";
import { AgentImportConflictModal } from "./AgentImportConflictModal";
import { AgentCreateModal } from "./AgentCreateModal";
import { AgentEditorModal } from "./AgentEditorModal";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import {
  presentAgentPersonaCatalog,
  importAgentPersonasWithConfirmation,
} from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaEditInput,
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useEffect, useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { pickAgentDefinitions } from "./pickAgentDefinitions";
import { useAtomCommand } from "../../state/use-atom-command";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../../features/settings/components/SettingsSection";

export function AgentLibrarySettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const effectiveEnvironmentId = connectedEnvironments.some(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
    ? selectedEnvironmentId
    : (connectedEnvironments[0]?.environmentId ?? null);
  const catalog = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : agentPersonaEnvironment.catalog({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    error: AgentPersonaImportConflictError;
    resolve: (selected: ReadonlyArray<AgentPersonaImportConflict> | null) => void;
  } | null>(null);
  useEffect(() => () => confirmation?.resolve(null), [confirmation]);
  const [editing, setEditing] = useState<{
    environmentId: EnvironmentId;
    initial: AgentPersonaEditInput;
  } | null>(null);
  const [notification, setNotification] = useState<AgentLibraryNotification | null>(null);
  const [creating, setCreating] = useState(false);
  const dismissNotification = useCallback(() => setNotification(null), []);
  const importAgents = useAtomCommand(agentPersonaEnvironment.importAgentPersonas, {
    reportFailure: false,
  });
  const removeAgent = useAtomCommand(agentPersonaEnvironment.removeAgentPersona, {
    reportFailure: false,
  });
  const restoreAgent = useAtomCommand(agentPersonaEnvironment.restoreSourceAgentPersona, {
    reportFailure: false,
  });
  async function importSelection(kind: "folder" | "agent") {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const files = await pickAgentDefinitions(kind);
      if (files === null) return;
      const result = await importAgentPersonasWithConfirmation(
        files,
        async (input) => {
          const response = await importAgents({ environmentId, input });
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          return response.value;
        },
        (error) =>
          new Promise<ReadonlyArray<AgentPersonaImportConflict> | null>((resolve) => {
            setConfirmation({ error, resolve });
          }),
      );
      if (result === null) return;
      setNotification({
        type: "success",
        title: `Imported ${result.importedIds.length} agent(s).`,
      });
      catalog.refresh();
    } catch (error) {
      setNotification({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const setAgentEnabled = useAtomCommand(agentPersonaEnvironment.setImportedAgentPersonaEnabled, {
    reportFailure: false,
  });
  async function toggleAgent(personaId: string, enabled: boolean) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await setAgentEnabled({ environmentId, input: { personaId, enabled } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      catalog.refresh();
    } catch (error) {
      setNotification({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function removePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await removeAgent({
        environmentId,
        input: { personaId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setNotification({ type: "success", title: "Agent removed" });
      catalog.refresh();
    } catch (error) {
      setNotification({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function restorePersona(personaId: string) {
    if (effectiveEnvironmentId === null || busy) return;
    const environmentId = effectiveEnvironmentId;
    setBusy(true);
    try {
      const result = await restoreAgent({ environmentId, input: { personaId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setNotification({ type: "success", title: "Agent restored" });
      catalog.refresh();
    } catch (error) {
      setNotification({
        type: "error",
        title: "Agent action failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  const personas =
    catalog.data === null || catalog.data === undefined
      ? []
      : presentAgentPersonaCatalog(catalog.data);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {confirmation ? (
        <AgentImportConflictModal
          key={JSON.stringify(confirmation.error.conflicts)}
          error={confirmation.error}
          onConfirm={(selected) => {
            confirmation.resolve(selected);
            setConfirmation(null);
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Agents" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Agent library">
          <View className="rounded-2xl bg-card px-4 py-3">
            <Text className="text-base text-foreground">
              Run Books activate agents from this environment’s library. Edit imported agents here.
            </Text>
          </View>
        </SettingsSection>

        {connectedEnvironments.length > 1 ? (
          <SettingsSection title="Environment">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {connectedEnvironments.map((environment) => {
                  const selected = environment.environmentId === effectiveEnvironmentId;
                  return (
                    <Pressable
                      key={environment.environmentId}
                      accessibilityLabel={environment.environmentLabel}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      className={cn(
                        "rounded-full border px-4 py-2",
                        selected ? "border-primary bg-primary/10" : "border-border bg-card",
                      )}
                      disabled={busy}
                      onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Text className="text-sm font-t3-medium text-foreground">
                        {environment.environmentLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </SettingsSection>
        ) : null}

        <View className="flex-row flex-wrap items-center justify-between gap-3 px-2">
          <Text className="text-sm font-t3-medium text-foreground-muted">Scoped agents</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create agent"
              accessibilityState={{ disabled: busy || effectiveEnvironmentId === null }}
              disabled={busy || effectiveEnvironmentId === null}
              className="flex-row items-center gap-2 rounded-lg border border-border px-4 py-3 disabled:opacity-40"
              onPress={() => setCreating(true)}
            >
              <SymbolView
                name="plus"
                size={14}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-sm text-foreground">Create</Text>
            </Pressable>
            {Platform.OS === "web" ? (
              <Text className="text-sm text-foreground-muted">
                Use Settings → Agents in the web app to import files.
              </Text>
            ) : (
              <View
                className="self-start"
                pointerEvents={busy || effectiveEnvironmentId === null ? "none" : "auto"}
              >
                <ControlPillMenu
                  actions={[
                    {
                      id: "agent",
                      title: "Agent file",
                      attributes: { disabled: busy || effectiveEnvironmentId === null },
                    },
                    {
                      id: "folder",
                      title: "Folder",
                      attributes: { disabled: busy || effectiveEnvironmentId === null },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "agent" || nativeEvent.event === "folder")
                      void importSelection(nativeEvent.event);
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Import agents"
                    accessibilityState={{ disabled: busy || effectiveEnvironmentId === null }}
                    disabled={busy || effectiveEnvironmentId === null}
                    className="flex-row items-center gap-2 rounded-lg border border-border px-4 py-3 disabled:opacity-40"
                  >
                    <Text className="text-sm text-foreground">Import</Text>
                    <SymbolView
                      name="chevron.down"
                      size={14}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  </Pressable>
                </ControlPillMenu>
              </View>
            )}
          </View>
        </View>
        <SettingsSection>
          <View className="gap-2">
            {effectiveEnvironmentId === null ? (
              <AgentMessage title="No connected environments" />
            ) : catalog.isPending ? (
              <AgentMessage title="Loading agents" />
            ) : catalog.error ? (
              <AgentMessage title={catalog.error} />
            ) : personas.length === 0 ? (
              <AgentMessage title="No personas in this library" />
            ) : (
              personas.map((persona) => {
                const available = persona.availability === "available";
                return (
                  <View key={persona.personaId} className="gap-2 rounded-2xl bg-card px-4 py-3">
                    <View className="flex-row items-center gap-3">
                      <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                        <Text className="shrink text-lg font-t3-semibold text-foreground">
                          {persona.displayName}
                        </Text>
                        <View
                          className={cn(
                            "rounded-full border px-2 py-0.5",
                            available ? "border-primary/30 bg-primary/10" : "border-border",
                          )}
                        >
                          <Text className="text-xs font-t3-medium text-foreground-muted">
                            {persona.availabilityLabel}
                          </Text>
                        </View>
                      </View>
                      {persona.removed ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Restore ${persona.displayName}`}
                          accessibilityState={{ disabled: busy }}
                          disabled={busy}
                          className="h-11 flex-row items-center gap-2 rounded-lg border border-border px-3 disabled:opacity-40"
                          onPress={() => void restorePersona(persona.personaId)}
                        >
                          <SymbolView
                            name="arrow.uturn.backward"
                            size={16}
                            tintColorClassName="accent-icon"
                            type="monochrome"
                          />
                          <Text className="text-sm text-foreground">Restore</Text>
                        </Pressable>
                      ) : (
                        <View className="flex-row items-center gap-2">
                          {persona.imported ? (
                            <Switch
                              value={persona.enabled}
                              disabled={busy}
                              accessibilityLabel={`Enable ${persona.displayName}`}
                              onValueChange={(enabled) =>
                                void toggleAgent(persona.personaId, enabled)
                              }
                            />
                          ) : null}
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Edit ${persona.displayName}`}
                            accessibilityHint={
                              persona.edit
                                ? "Edit this imported copy"
                                : "Import a copy to edit this agent"
                            }
                            accessibilityState={{ disabled: busy || persona.edit === null }}
                            disabled={busy || persona.edit === null}
                            className="size-11 items-center justify-center rounded-lg disabled:opacity-40"
                            onPress={() => {
                              if (persona.edit && effectiveEnvironmentId)
                                setEditing({
                                  environmentId: effectiveEnvironmentId,
                                  initial: persona.edit,
                                });
                            }}
                          >
                            <SymbolView
                              name="pencil"
                              size={18}
                              tintColorClassName="accent-icon"
                              type="monochrome"
                            />
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${persona.displayName}`}
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            className="size-11 items-center justify-center rounded-lg border border-danger-foreground/30 disabled:opacity-40"
                            onPress={() => void removePersona(persona.personaId)}
                          >
                            <SymbolView
                              name="trash"
                              size={18}
                              tintColorClassName="accent-danger-foreground"
                              type="monochrome"
                            />
                          </Pressable>
                        </View>
                      )}
                    </View>
                    <Text className="text-sm text-foreground-muted">{persona.description}</Text>
                  </View>
                );
              })
            )}
          </View>
        </SettingsSection>
      </ScrollView>
      {notification ? (
        <AgentLibraryToast notification={notification} onDismiss={dismissNotification} />
      ) : null}
      {creating && effectiveEnvironmentId ? (
        <AgentCreateModal
          environmentId={effectiveEnvironmentId}
          onClose={() => setCreating(false)}
          onCreated={(displayName) => {
            setCreating(false);
            setNotification({ type: "success", title: `Created ${displayName}` });
            catalog.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <AgentEditorModal
          key={`${editing.environmentId}:${editing.initial.personaId}`}
          {...editing}
          onClose={() => {
            setEditing(null);
            catalog.refresh();
          }}
          onSaved={() => {
            setEditing(null);
            catalog.refresh();
          }}
        />
      ) : null}
    </View>
  );
}

function AgentMessage(props: { readonly title: string }) {
  return (
    <View className="rounded-2xl bg-card px-4 py-4">
      <Text className="text-base text-foreground-muted">{props.title}</Text>
    </View>
  );
}
