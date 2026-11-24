import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useFocusEffect } from "@react-navigation/native";
import { playbookStepLabel } from "@t3tools/client-runtime/j5/playbooks";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { InfoRow } from "../agents/InfoRow";
import { FormSelectRow } from "../agents/PersonaFormRows";
import { useSettingsFormNavigation } from "../agents/SettingsFormScreen";
import { useOwnedEnvironmentIds } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { useStartPlaybookConversation } from "./startPlaybookConversation";

export function PlaybookLibrarySettingsSection({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // Playbooks are managed on the servers the person owns (People and access AC27).
  const owned = useOwnedEnvironmentIds();
  const environments = connectedEnvironments.filter((entry) => owned.has(entry.environmentId));
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment ? (
    <PlaybookLibrary
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.environmentLabel}
      environments={environments.map((entry) => ({
        environmentId: entry.environmentId,
        label: entry.environmentLabel,
      }))}
    />
  ) : (
    <InfoRow text="No environment connected." />
  );
}

function PlaybookLibrary({
  environmentId,
  label,
  environments,
}: {
  environmentId: EnvironmentId;
  label: string;
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  // As upstream's pickers: an archived project is not offered, but the chosen one stays listed.
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) =>
      project.environmentId === environmentId &&
      (project.archivedAt == null || project.id === projectId),
  );
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  // A project's .j5/playbooks files join the list and win over a same-named library copy.
  const scope = project ? { projectId: project.id } : {};
  const query = useEnvironmentQuery(j5Environment.playbookLibrary({ environmentId, input: scope }));
  const sources = useEnvironmentQuery(j5Environment.playbookSources({ environmentId, input: {} }));
  const canOperate = useAtomValue(j5Environment.savePlaybook.permissionAtom(environmentId));
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  const exportDefinition = useAtomCommand(j5Environment.exportPlaybook, { reportFailure: false });
  const remove = useAtomCommand(j5Environment.deletePlaybook, { reportFailure: false });
  const navigation = useSettingsFormNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startConversation = useStartPlaybookConversation(environmentId);
  const openConversation = (playbook: string | null) =>
    void act(() => startConversation({ playbook, projects, projectId: project?.id ?? null }));
  const [details, setDetails] = useState<string | null>(null);
  const folderPaths = (sources.data?.folders ?? []).flatMap((entry) =>
    entry.source.kind === "folder" ? [entry.source.path] : [],
  );
  const detail = query.data?.playbooks.find((entry) => entry.name === details);
  const { refresh } = query;
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await settlePromise(operation);
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Playbook action failed.");
      return;
    }
    query.refresh();
    sources.refresh();
  }
  async function changeFolders(folders: string[]) {
    const result = await setFolders({ environmentId, input: { folders } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }
  const libraryActions: MenuAction[] = [
    { id: "create", title: "Create playbook", attributes: { disabled: busy || !canOperate } },
    { id: "import", title: "Import YAML", attributes: { disabled: busy || !canOperate } },
    {
      id: "folder",
      title: "Add source folder",
      attributes: { disabled: busy || !canOperate || !sources.data },
    },
    { id: "refresh", title: "Refresh", attributes: { disabled: busy } },
  ];
  return (
    <>
      {projects.length > 0 ? (
        <FormSelectRow
          label="Project"
          value={project?.title ?? "Library only"}
          actions={[
            { id: "", title: "Library only", state: project ? "off" : "on" },
            ...projects.map((entry) => ({
              id: entry.id,
              title: entry.title,
              state: entry.id === project?.id ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) => setProjectId(id ? (id as ProjectId) : null)}
        />
      ) : (
        <InfoRow text="Available in every project." />
      )}
      {project ? (
        <InfoRow
          borderTop
          text={`Includes ${project.title}'s .j5/playbooks folder. Those override a library playbook with the same name in that project.`}
        />
      ) : null}
      {error || sources.error || query.error ? (
        <InfoRow borderTop tone="danger" text={error ?? sources.error ?? query.error ?? ""} />
      ) : null}
      {query.isPending && !query.data ? <InfoRow borderTop text="Loading playbooks…" /> : null}
      {query.data?.playbooks.length === 0 ? (
        <InfoRow borderTop text="No playbooks yet. Create one with your agent, or import YAML." />
      ) : null}
      {query.data?.playbooks.map((playbook) => {
        const source = playbook.source ?? { kind: "environment" };
        return (
          <View
            key={playbook.name}
            className="flex-row items-center gap-2 border-t border-border-subtle py-2 pl-4 pr-1"
          >
            <View className="min-w-0 flex-1 gap-1 py-1">
              <Text textRole="body" className="font-t3-medium text-foreground">
                {playbook.title}
              </Text>
              <Text className="text-sm text-foreground-muted">{playbook.description}</Text>
              <Text className="text-xs text-foreground-muted">
                {playbook.stepCount} {playbook.stepCount === 1 ? "step" : "steps"}
                {source.kind === "folder" ? ` · From source folder on ${label}` : ""}
                {source.kind === "workspace"
                  ? ` · From ${project?.title ?? "project"} on ${label}`
                  : ""}
                {source.kind === "environment" ? ` · Library on ${label}` : ""}
                {playbook.overridesLibrary ? " · Overrides library copy" : ""}
              </Text>
              {playbook.issue ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {playbook.issue.message}
                </Text>
              ) : null}
              {(playbook.warnings ?? []).map((warning) => (
                <Text
                  accessibilityRole="alert"
                  key={`${warning.stepId}:${warning.code}`}
                  className="text-sm text-warning-foreground"
                >
                  {warning.message}
                </Text>
              ))}
            </View>
            <OverflowMenu
              accessibilityLabel={`More actions for ${playbook.title}`}
              actions={[
                {
                  id: "chat",
                  title: "Prepare chat",
                  attributes: { disabled: busy || !!playbook.issue },
                },
                { id: "steps", title: "View steps", attributes: { disabled: !!playbook.issue } },
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
                    (entry) =>
                      entry.environmentId !== environmentId || source.kind !== "environment",
                  )
                  .map((entry) => ({
                    id: `copy:${entry.environmentId}`,
                    title:
                      entry.environmentId === environmentId
                        ? "Copy to library"
                        : `Copy to ${entry.label}`,
                    attributes: { disabled: busy || !!playbook.issue },
                  })),
                {
                  id: "delete",
                  title:
                    source.kind === "folder" ? "Delete unavailable: edit source folder" : "Delete",
                  attributes: {
                    destructive: true,
                    disabled: busy || !canOperate || source.kind === "folder",
                  },
                },
              ]}
              onAction={(action) => {
                if (action === "chat") openConversation(playbook.name);
                else if (action === "steps") setDetails(playbook.name);
                else if (action.startsWith("copy:")) {
                  const destination = environments.find(
                    (entry) => `copy:${entry.environmentId}` === action,
                  );
                  if (destination)
                    navigation.navigate("SettingsPlaybookEditor", {
                      environmentId,
                      ...(project ? { projectId: project.id } : {}),
                      mode: {
                        kind: "copy",
                        name: playbook.name,
                        source,
                        destination: destination.environmentId,
                      },
                    });
                } else if (action === "rename")
                  navigation.navigate("SettingsPlaybookEditor", {
                    environmentId,
                    ...(project ? { projectId: project.id } : {}),
                    mode: { kind: "rename", name: playbook.name, title: playbook.title, source },
                  });
                else if (action === "export")
                  void act(async () => {
                    const result = await exportDefinition({
                      environmentId,
                      input: { ...scope, name: playbook.name, source },
                    });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    await Share.share({
                      title: result.value.fileName,
                      message: result.value.yaml,
                    });
                  });
                else if (action === "delete")
                  Dialog.confirm({
                    title: "Delete playbook?",
                    message:
                      source.kind === "workspace"
                        ? `${playbook.title} is removed from ${project?.title ?? "the project"}'s .j5/playbooks folder.`
                        : `${playbook.title} is removed from ${label}'s library.`,
                    confirmText: "Delete",
                    destructive: true,
                    onConfirm: () =>
                      void act(async () => {
                        const result = await remove({
                          environmentId,
                          input: { ...scope, name: playbook.name, source },
                        });
                        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      }),
                  });
              }}
            />
          </View>
        );
      })}
      {sources.data?.folders
        .filter((entry) => entry.source.kind === "folder" || entry.issue)
        .map((entry) => (
          <View
            key={entry.path}
            className="flex-row items-center gap-2 border-t border-border-subtle py-2 pl-4 pr-1"
          >
            <View className="min-w-0 flex-1 gap-1 py-1">
              <Text
                textRole="body"
                className="text-foreground"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {entry.source.kind === "folder" ? entry.path : "Environment library"}
              </Text>
              {entry.issue ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {entry.issue.message}
                </Text>
              ) : null}
            </View>
            {entry.source.kind === "folder" ? (
              <OverflowMenu
                accessibilityLabel={`Actions for ${entry.path}`}
                actions={[
                  {
                    id: "remove",
                    title: "Remove source",
                    attributes: { destructive: true, disabled: !canOperate || busy },
                  },
                ]}
                onAction={() =>
                  void act(() =>
                    changeFolders(
                      folderPaths.filter(
                        (folder) => entry.source.kind !== "folder" || folder !== entry.source.path,
                      ),
                    ),
                  )
                }
              />
            ) : null}
          </View>
        ))}
      <Menu
        actions={libraryActions}
        onPressAction={({ nativeEvent }) => {
          const action = nativeEvent.event;
          if (action === "create") openConversation(null);
          else if (action === "import")
            navigation.navigate("SettingsPlaybookEditor", {
              environmentId,
              mode: { kind: "import" },
            });
          else if (action === "folder")
            navigation.navigate("SettingsPlaybookFolder", {
              environmentId,
              environmentLabel: label,
            });
          else {
            query.refresh();
            sources.refresh();
          }
        }}
      >
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel="Add or manage playbooks"
          className="border-t border-border-subtle bg-grouped-card"
        >
          <ListRowLayout icon="plus" label="Add / manage" />
        </RowPressable>
      </Menu>
      {detail ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setDetails(null)}
        >
          {/* SafeAreaView takes no className, so the theme surface and flex go on a View. */}
          <View className="flex-1 bg-sheet">
            <SafeAreaView style={{ flex: 1 }}>
              {/* The persona sheet's header, so both sheets close the same way (D14). */}
              <SheetHeader
                presentation="inline"
                title={detail.title}
                onClose={() => setDetails(null)}
              />
              <ScrollView contentContainerClassName="gap-3 px-5 pb-6">
                <Text className="text-foreground-muted">{detail.description}</Text>
                {detail.steps.map((step, index) => (
                  <Text key={step.id}>{playbookStepLabel(step, index)}</Text>
                ))}
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

/** An ellipsis that opens a row's actions, as the persona library's folder rows do. */
function OverflowMenu(props: {
  readonly accessibilityLabel: string;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
}) {
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        className="size-11 items-center justify-center"
      >
        <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
    </Menu>
  );
}
