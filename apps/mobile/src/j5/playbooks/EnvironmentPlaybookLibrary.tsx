import { playbookStepLabel } from "@t3tools/client-runtime/j5/playbooks";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PlaybookSource } from "@t3tools/contracts/j5";
import { useState } from "react";
import { Alert, Pressable, Share, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { AgentFolderPickerModal } from "../agents/AgentFolderPickerModal";
import { useGuestEnvironmentIds } from "../sharing/guestAccess";
import { j5Environment } from "../state";

export function EnvironmentPlaybookLibrary() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const guests = useGuestEnvironmentIds();
  const environments = connectedEnvironments.filter((entry) => !guests.has(entry.environmentId));
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === selected) ?? environments[0];
  return (
    <View className="gap-3">
      <Text className="font-semibold text-foreground">Environment playbook library</Text>
      <Text className="text-muted-foreground">
        New playbooks are available across all projects and worktrees on the selected environment.
      </Text>
      <ControlPillMenu
        actions={environments.map((entry) => ({
          id: entry.environmentId,
          title: entry.environmentLabel,
          state: entry.environmentId === environment?.environmentId ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) => {
          const entry = environments.find((item) => item.environmentId === nativeEvent.event);
          if (entry) setSelected(entry.environmentId);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Playbook library environment"
          className="rounded-lg border border-border p-3"
        >
          <Text>{environment?.environmentLabel ?? "No environment connected"}</Text>
        </Pressable>
      </ControlPillMenu>
      {environment ? (
        <EnvironmentLibrary
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.environmentLabel}
          environments={environments.map((entry) => ({
            environmentId: entry.environmentId,
            label: entry.environmentLabel,
          }))}
        />
      ) : null}
    </View>
  );
}

function EnvironmentLibrary({
  environmentId,
  label,
  environments,
}: {
  environmentId: EnvironmentId;
  label: string;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const [source, setSource] = useState<PlaybookSource>({ kind: "environment" });
  const sources = useEnvironmentQuery(j5Environment.playbookSources({ environmentId, input: {} }));
  const query = useEnvironmentQuery(
    j5Environment.playbookLibrary({ environmentId, input: { source } }),
  );
  const canOperate = useAtomValue(j5Environment.savePlaybook.permissionAtom(environmentId));
  const save = useAtomCommand(j5Environment.savePlaybook, { reportFailure: false });
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const remove = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const rename = useAtomCommand(j5Environment.renamePlaybook, { reportFailure: false });
  const [picking, setPicking] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState<{
    name: string;
    destination: EnvironmentId;
    source: PlaybookSource;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ name: string; title: string } | null>(null);
  const folderPaths = (sources.data?.folders ?? []).flatMap((entry) =>
    entry.source.kind === "folder" ? [entry.source.path] : [],
  );
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      query.refresh();
      sources.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Playbook action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function changeFolders(folders: string[]) {
    const result = await setFolders({ environmentId, input: { folders } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            query.refresh();
            sources.refresh();
          }}
          className="rounded-lg border border-border p-3"
        >
          <Text>Refresh</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !canOperate || !sources.data}
          onPress={() => setPicking(true)}
          className="rounded-lg border border-border p-3 disabled:opacity-40"
        >
          <Text>Add folder</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !canOperate}
          onPress={() => setShowSave(!showSave)}
          className="rounded-lg border border-border p-3 disabled:opacity-40"
        >
          <Text>Save YAML</Text>
        </Pressable>
      </View>
      {picking ? (
        <AgentFolderPickerModal
          environmentId={environmentId}
          environmentLabel={label}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setPicking(false);
            void act(() => changeFolders([...folderPaths, path]));
          }}
        />
      ) : null}
      {error || sources.error || query.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? sources.error ?? query.error}
        </Text>
      ) : null}
      {sources.isPending && !sources.data ? <Text>Loading library sources…</Text> : null}
      {sources.data?.folders.map((entry) => (
        <View key={entry.path} className="gap-2 rounded-lg border border-border p-3">
          <Text>{entry.source.kind === "environment" ? "Environment library" : "Folder"}</Text>
          <Text className="text-muted-foreground">{entry.path}</Text>
          {entry.issue ? (
            <Text accessibilityRole="alert" className="text-destructive">
              {entry.issue.message}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setSource(entry.source);
              setRenameTarget(null);
            }}
          >
            <Text>View playbooks</Text>
          </Pressable>
          {entry.source.kind === "folder" ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || !canOperate}
              onPress={() =>
                void act(async () => {
                  await changeFolders(
                    folderPaths.filter(
                      (path) => entry.source.kind !== "folder" || path !== entry.source.path,
                    ),
                  );
                  setSource({ kind: "environment" });
                })
              }
            >
              <Text>Remove folder</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {showSave ? (
        <View className="gap-3">
          <Text>Save a new playbook to this environment. Existing names are never replaced.</Text>
          <TextInput
            accessibilityLabel="New environment playbook name"
            value={name}
            onChangeText={setName}
            editable={!busy}
            autoCapitalize="none"
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Playbook YAML"
            value={yaml}
            onChangeText={setYaml}
            editable={!busy}
            multiline
            className="min-h-32 rounded-lg border border-border p-3 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !canOperate || !name || !yaml}
            onPress={() =>
              void act(async () => {
                const result = await save({ environmentId, input: { name, yaml } });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setName("");
                setYaml("");
                setShowSave(false);
                setSource({ kind: "environment" });
              })
            }
          >
            <Text>Save playbook</Text>
          </Pressable>
        </View>
      ) : null}
      {copyTarget ? (
        <View className="gap-3">
          <Text>
            Copy to{" "}
            {environments.find((entry) => entry.environmentId === copyTarget.destination)?.label}.
            Copies remain independent.
          </Text>
          <TextInput
            accessibilityLabel="Copied playbook name"
            value={name}
            onChangeText={setName}
            editable={!busy}
            autoCapitalize="none"
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !name}
            onPress={() =>
              void act(async () => {
                const exported = await exportDefinition({
                  environmentId,
                  input: { name: copyTarget.name, source: copyTarget.source },
                });
                if (exported._tag === "Failure") throw squashAtomCommandFailure(exported);
                const result = await save({
                  environmentId: copyTarget.destination,
                  input: { name, yaml: exported.value.yaml },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setCopyTarget(null);
                setName("");
                Alert.alert("Playbook copied", "Available across the destination environment.");
              })
            }
          >
            <Text>Copy playbook</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => setCopyTarget(null)}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {renameTarget ? (
        <View className="gap-3">
          <TextInput
            accessibilityLabel="Playbook title"
            value={renameTarget.title}
            onChangeText={(title) => setRenameTarget({ ...renameTarget, title })}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !renameTarget.title.trim()}
            onPress={() =>
              void act(async () => {
                const result = await rename({
                  environmentId,
                  input: { name: renameTarget.name, title: renameTarget.title, source },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                setRenameTarget(null);
              })
            }
          >
            <Text>Save title</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => setRenameTarget(null)}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <Text className="font-semibold text-foreground">
        {source.kind === "folder" ? source.path : "Saved environment playbooks"}
      </Text>
      {query.isPending && !query.data ? <Text>Loading playbooks…</Text> : null}
      {query.data?.playbooks.length === 0 ? <Text>No playbooks in this source yet.</Text> : null}
      {query.data?.playbooks.map((playbook) => (
        <View key={playbook.name} className="gap-2 rounded-lg border border-border p-3">
          <Text className="font-semibold text-foreground">{playbook.title}</Text>
          <Text className="text-muted-foreground">{playbook.description}</Text>
          {playbook.issue ? (
            <Text accessibilityRole="alert" className="text-destructive">
              {playbook.issue.message}
            </Text>
          ) : null}
          {!playbook.issue
            ? playbook.steps.map((step, index) => (
                <Text key={step.id}>{playbookStepLabel(step, index)}</Text>
              ))
            : null}
          {(playbook.warnings ?? []).map((warning) => (
            <Text key={`${warning.stepId}:${warning.code}`} className="text-warning-foreground">
              {warning.message}
            </Text>
          ))}
          <ControlPillMenu
            actions={[
              {
                id: "export",
                title: "Export YAML",
                attributes: { disabled: busy || !!playbook.issue },
              },
              {
                id: "rename",
                title:
                  source.kind === "folder" ? "Rename unavailable: edit source folder" : "Rename",
                attributes: {
                  disabled: busy || !canOperate || source.kind === "folder" || !!playbook.issue,
                },
              },
              ...environments
                .filter(
                  (entry) => entry.environmentId !== environmentId || source.kind === "folder",
                )
                .map((entry) => ({
                  id: `copy:${entry.environmentId}`,
                  title:
                    entry.environmentId === environmentId
                      ? "Copy to environment library"
                      : `Copy to ${entry.label}`,
                  attributes: { disabled: busy || !!playbook.issue },
                })),
              {
                id: "delete",
                title:
                  source.kind === "folder"
                    ? "Delete unavailable: edit source folder"
                    : "Delete playbook",
                attributes: { disabled: busy || !canOperate || source.kind === "folder" },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              const action = nativeEvent.event;
              if (action.startsWith("copy:")) {
                const target = environments.find(
                  (entry) => `copy:${entry.environmentId}` === action,
                );
                if (target) {
                  setCopyTarget({ name: playbook.name, destination: target.environmentId, source });
                  setName(playbook.name);
                }
              } else if (action === "rename")
                setRenameTarget({ name: playbook.name, title: playbook.title });
              else if (action === "export")
                void act(async () => {
                  const result = await exportDefinition({
                    environmentId,
                    input: { name: playbook.name, source },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  await Share.share({ title: result.value.fileName, message: result.value.yaml });
                });
              else if (action === "delete")
                Alert.alert("Delete playbook", `Delete ${playbook.name} from this environment?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () =>
                      void act(async () => {
                        const result = await remove({
                          environmentId,
                          input: { name: playbook.name, source },
                        });
                        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      }),
                  },
                ]);
            }}
          >
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="self-start rounded-lg border border-border p-3"
            >
              <Text>Actions</Text>
            </Pressable>
          </ControlPillMenu>
        </View>
      ))}
    </View>
  );
}
