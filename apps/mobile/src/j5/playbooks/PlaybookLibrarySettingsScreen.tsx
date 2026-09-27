import {
  ensurePlaybookAuthor,
  playbookAuthorLaunch,
  playbookAuthorSquadrons,
  playbookWorkspaces,
} from "@t3tools/client-runtime/j5/playbooks";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { threadEnvironment } from "../../state/threads";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import { j5Environment } from "../state";
import { preparePlaybookDraft } from "./preparePlaybookDraft";
import { playbookWorkspaceInputsAtom } from "./workspaceInputs";

export const PlaybookLibrarySettingsSection = memo(function PlaybookLibrarySettingsSection() {
  const navigation = useNavigation();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const workspaceInputs = useAtomValue(playbookWorkspaceInputsAtom);
  const workspaces = useMemo(
    () => playbookWorkspaces(workspaceInputs.projects, workspaceInputs.threads),
    [workspaceInputs],
  );
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ name: string; title: string } | null>(null);
  const workspace = workspaces.find((entry) => entry.key === workspaceKey) ?? workspaces[0];
  const squadronQuery = useEnvironmentQuery(
    workspace
      ? j5Environment.squadrons({ environmentId: workspace.environmentId, input: {} })
      : null,
  );
  const authorSquadrons = workspace
    ? playbookAuthorSquadrons(
        workspace,
        (squadronQuery.data ?? []).map((entry) => ({
          ...entry,
          environmentId: workspace.environmentId,
          environmentLabel: "",
          available: true,
        })),
      )
    : [];
  const [authorScope, setAuthorScope] = useState<{
    workspaceKey: string;
    squadronId: string;
  } | null>(null);
  const authorSquadron =
    authorScope !== null && authorScope.workspaceKey === workspace?.key
      ? authorSquadrons.find(({ squadron }) => squadron.id === authorScope.squadronId)
      : authorSquadrons.length === 1
        ? authorSquadrons[0]
        : undefined;
  const query = useEnvironmentQuery(
    workspace
      ? j5Environment.playbookLibrary({
          environmentId: workspace.environmentId,
          input: {
            projectId: workspace.projectId,
            ...(workspace.threadId ? { threadId: workspace.threadId } : {}),
          },
        })
      : null,
  );
  const { refresh } = query;
  const deletePlaybook = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const renamePlaybook = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const serverConfigs = useServerConfigs();
  const readCatalog = useAtomQueryRunner(agentPersonaEnvironment.catalog, {
    reportFailure: false,
    refresh: true,
  });
  const createPersona = useAtomCommand(agentPersonaEnvironment.createAgentPersona, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const authorStarting = useRef(false);
  const authorLaunch = useRef<{
    workspaceKey: string;
    target: Parameters<typeof startTurn>[0];
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  function openDraft(prompt: string) {
    if (!workspace) return;
    const draftId = preparePlaybookDraft(workspace, prompt);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: workspace.environmentId,
        projectId: workspace.projectId,
        title: workspace.title,
        draftId,
      },
    });
  }
  async function createPlaybook() {
    if (!workspace || !query.data || !authorSquadron || creating || authorStarting.current) return;
    authorStarting.current = true;
    setCreating(true);
    try {
      const environmentId = workspace.environmentId;
      const workspaceKey = JSON.stringify([
        workspace.key,
        query.data.workspaceRoot,
        authorSquadron.squadron.id,
      ]);
      if (authorLaunch.current?.workspaceKey !== workspaceKey) {
        const modelSelection = await ensurePlaybookAuthor({
          providers: serverConfigs.get(environmentId)?.providers ?? [],
          readCatalog: async () => {
            const result = await readCatalog({ environmentId, input: {} });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          createPersona: async (input) => {
            const result = await createPersona({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        });
        const metadata = makeTurnCommandMetadata();
        authorLaunch.current = {
          workspaceKey,
          target: playbookAuthorLaunch({
            workspace: { ...workspace, workspaceRoot: query.data.workspaceRoot },
            squadron: authorSquadron,
            modelSelection,
            commandId: CommandId.make(metadata.commandId),
            threadId: ThreadId.make(metadata.threadId),
            messageId: MessageId.make(metadata.messageId),
            createdAt: metadata.createdAt,
          }),
        };
      }
      const { target } = authorLaunch.current;
      const result = await startTurn(target);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      navigation.navigate("Thread", {
        environmentId,
        threadId: target.input.threadId,
      });
      authorLaunch.current = null;
    } catch (cause) {
      Alert.alert(
        "Could not start Playbook Author",
        cause instanceof Error ? cause.message : "Try again.",
      );
    } finally {
      authorStarting.current = false;
      setCreating(false);
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
  const disabled = !workspace || !query.data || !!query.error || deleting || renaming || creating;
  return (
    <View className="gap-4 p-4">
      <Text className="text-sm text-muted-foreground">
        Reusable prompts that guide an agent through ordered steps. Create and refine them in a
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
      {workspace && (
        <ControlPillMenu
          actions={authorSquadrons.map((entry) => ({
            id: entry.squadron.id,
            title: entry.squadron.name,
            state:
              entry.squadron.id === authorSquadron?.squadron.id
                ? ("on" as const)
                : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) =>
            setAuthorScope({ workspaceKey: workspace.key, squadronId: nativeEvent.event })
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Playbook author Squadron"
            className="rounded-lg border border-border p-3"
          >
            <Text className="text-foreground">
              {authorSquadron?.squadron.name ??
                (authorSquadrons.length === 0
                  ? "No authoring Squadron for this project"
                  : "Choose authoring Squadron")}
            </Text>
          </Pressable>
        </ControlPillMenu>
      )}
      <View className="flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={disabled || !authorSquadron}
          onPress={() => void createPlaybook()}
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
      {squadronQuery.error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {squadronQuery.error}
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
            {playbook.name}.yaml · {playbook.stepCount} steps
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
    </View>
  );
});
