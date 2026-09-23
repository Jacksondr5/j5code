import { CREATE_PLAYBOOK_PROMPT, playbookWorkspaces } from "@t3tools/client-runtime/j5/playbooks";
import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import {
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";

const environment = createJ5EnvironmentAtoms(connectionAtomRuntime);

export function PlaybookLibrarySettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const workspaces = playbookWorkspaces(useProjects(), useThreadShells());
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ name: string; title: string } | null>(null);
  const workspace = workspaces.find((entry) => entry.key === workspaceKey) ?? workspaces[0];
  const query = useEnvironmentQuery(
    workspace
      ? environment.playbookLibrary({
          environmentId: workspace.environmentId,
          input: {
            projectId: workspace.projectId,
            ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          },
        })
      : null,
  );
  const { refresh } = query;
  const deletePlaybook = useAtomCommand(environment.deletePlaybook, { reportFailure: false });
  const renamePlaybook = useAtomCommand(environment.renamePlaybook, { reportFailure: false });
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  function openDraft(prompt: string) {
    if (!workspace) return;
    if (workspace.threadId) {
      const key = scopedThreadKey(workspace.environmentId, workspace.threadId);
      if (!isComposerDraftEmpty(getComposerDraftSnapshot(key))) {
        Alert.alert(
          "Draft preserved",
          "Finish or clear this thread's existing draft before choosing a playbook action.",
        );
        return;
      }
      setComposerDraftText(key, prompt);
      navigation.navigate("Thread", {
        environmentId: workspace.environmentId,
        threadId: workspace.threadId,
      });
    } else {
      const key = `new-task:${scopedProjectKey(workspace.environmentId, workspace.projectId)}`;
      if (!isComposerDraftEmpty(getComposerDraftSnapshot(key))) {
        Alert.alert(
          "Draft preserved",
          "Finish or clear this project's existing draft before choosing a playbook action.",
        );
        return;
      }
      updateComposerDraftSettings(key, {
        workspaceSelection: {
          mode: "local",
          branch: null,
          worktreePath: null,
          startFromOrigin: false,
        },
      });
      setComposerDraftText(key, prompt);
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: workspace.environmentId,
          projectId: workspace.projectId,
          title: workspace.title,
        },
      });
    }
  }
  function confirmDelete(name: string) {
    if (!workspace || deleting) return;
    const selected = workspace;
    Alert.alert("Delete playbook", `Delete ${name}.yaml from ${selected.title}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setDeleting(true);
          void (async () => {
            try {
              const result = await deletePlaybook({
                environmentId: selected.environmentId,
                input: {
                  projectId: selected.projectId,
                  ...(selected.threadId ? { threadId: selected.threadId } : {}),
                  name,
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              refresh();
            } catch (cause) {
              Alert.alert(
                "Could not delete playbook",
                cause instanceof Error ? cause.message : "Try again.",
              );
            } finally {
              setDeleting(false);
            }
          })();
        },
      },
    ]);
  }
  async function submitRename() {
    if (!workspace || !renameTarget || renaming) return;
    const title = renameTarget.title.trim();
    if (!title) return;
    const current = query.data?.playbooks.find(({ name }) => name === renameTarget.name);
    if (title === current?.title) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const result = await renamePlaybook({
        environmentId: workspace.environmentId,
        input: {
          projectId: workspace.projectId,
          ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          name: renameTarget.name,
          title,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setRenameTarget(null);
      refresh();
    } catch (cause) {
      Alert.alert(
        "Could not rename playbook",
        cause instanceof Error ? cause.message : "Try again.",
      );
    } finally {
      setRenaming(false);
    }
  }
  const disabled = !workspace || !query.data || !!query.error || deleting || renaming;
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" && (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Playbooks" onBack={() => navigation.goBack()} />
        </>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <Text className="text-sm text-muted-foreground">
          Reusable prompts that guide an agent through ordered phases. Create and refine them in a
          conversation.
        </Text>
        <ControlPillMenu
          actions={workspaces.map((entry) => ({
            id: entry.key,
            title: `${entry.title}${connectedEnvironments.length > 1 ? ` · ${connectedEnvironments.find((env) => env.environmentId === entry.environmentId)?.environmentLabel ?? entry.environmentId}` : ""}`,
            state: entry.key === workspace?.key ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            setRenameTarget(null);
            setWorkspaceKey(nativeEvent.event);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Playbook workspace"
            className="rounded-lg border border-border p-3"
          >
            <Text className="text-foreground">{workspace?.title ?? "No projects available"}</Text>
          </Pressable>
        </ControlPillMenu>
        {workspace && (
          <Text className="text-xs text-muted-foreground">
            {query.data?.workspaceRoot ?? workspace.workspaceRoot}/.j5/playbooks
          </Text>
        )}
        <View className="flex-row gap-3">
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => openDraft(CREATE_PLAYBOOK_PROMPT)}
            className="rounded-lg border border-border p-3 disabled:opacity-40"
          >
            <Text className="text-foreground">Create playbook</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!workspace || query.isPending}
            onPress={refresh}
            className="rounded-lg border border-border p-3 disabled:opacity-40"
          >
            <Text className="text-foreground">Refresh</Text>
          </Pressable>
        </View>
        {query.error && (
          <Text accessibilityRole="alert" className="text-destructive">
            {query.error}
          </Text>
        )}
        {!workspace && (
          <Text className="text-muted-foreground">
            Connect an environment and add a project to create playbooks.
          </Text>
        )}
        {query.isPending && !query.data && (
          <Text className="text-muted-foreground">Loading playbooks…</Text>
        )}
        {query.data?.playbooks.length === 0 && (
          <Text className="text-muted-foreground">
            No playbooks in this workspace yet. Create one with your agent, then return here and
            refresh.
          </Text>
        )}
        {query.data?.playbooks.map((playbook) => (
          <View key={playbook.name} className="gap-2 rounded-lg border border-border p-4">
            {renameTarget?.name === playbook.name ? (
              <View className="gap-2">
                <TextInput
                  accessibilityLabel={`Name for ${playbook.name} playbook`}
                  autoFocus
                  editable={!renaming}
                  value={renameTarget.title}
                  onChangeText={(title) => setRenameTarget({ ...renameTarget, title })}
                  onSubmitEditing={() => void submitRename()}
                />
                <View className="flex-row gap-2">
                  <Pressable
                    accessibilityRole="button"
                    disabled={renaming || !renameTarget.title.trim()}
                    onPress={() => void submitRename()}
                    className="rounded-lg border border-border px-3 py-2 disabled:opacity-40"
                  >
                    <Text className="text-foreground">Save</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={renaming}
                    onPress={() => setRenameTarget(null)}
                    className="rounded-lg border border-border px-3 py-2 disabled:opacity-40"
                  >
                    <Text className="text-foreground">Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Text className="font-semibold text-foreground">{playbook.title}</Text>
            )}
            <Text className="text-xs text-muted-foreground">
              {playbook.name}.yaml · {playbook.stepCount} phases
            </Text>
            <Text className="text-sm text-muted-foreground">{playbook.description}</Text>
            {playbook.issue ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {playbook.issue.message}
              </Text>
            ) : (
              playbook.steps.map((step, index) => (
                <Text key={step.id} className="text-sm text-foreground">
                  {index + 1}. {step.title}
                </Text>
              ))
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Rename ${playbook.name} playbook`}
              disabled={disabled || !!playbook.issue}
              onPress={() => setRenameTarget({ name: playbook.name, title: playbook.title })}
              className="self-start rounded-lg border border-border px-3 py-2 disabled:opacity-40"
            >
              <Text className="text-foreground">Rename playbook</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={disabled || !!playbook.issue}
              onPress={() => openDraft(`Start playbook ${playbook.name}`)}
              className="self-start rounded-lg border border-border px-3 py-2 disabled:opacity-40"
            >
              <Text className="text-foreground">Prepare playbook chat</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${playbook.name} playbook`}
              disabled={disabled}
              onPress={() => confirmDelete(playbook.name)}
              className="self-start rounded-lg border border-border px-3 py-2 disabled:opacity-40"
            >
              <Text className="text-destructive">Delete playbook</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
