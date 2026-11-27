import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { cn } from "../../lib/cn";
import { useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Environment } from "../state";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { FormTextRow } from "./PersonaFormRows";
import { SettingsFormScreen, useSettingsFormParams } from "./SettingsFormScreen";

function browsePlatform(os: string | null | undefined): string {
  return os === "windows" ? "Win32" : os === "darwin" ? "MacIntel" : "Linux";
}

/** Adds a folder to the persona library. */
export function AgentFolderPickerScreen() {
  const props = useSettingsFormParams<"SettingsPersonaFolder">();
  const librarySources = useEnvironmentQuery(
    agentPersonaEnvironment.librarySources({ environmentId: props.environmentId, input: {} }),
  );
  const catalog = useEnvironmentQuery(
    agentPersonaEnvironment.catalog({ environmentId: props.environmentId, input: {} }),
  );
  const setLibraryFolders = useAtomCommand(agentPersonaEnvironment.setLibraryFolders, {
    reportFailure: false,
  });
  return (
    <FolderPickerPage
      environmentId={props.environmentId}
      environmentLabel={props.environmentLabel}
      ready={librarySources.data !== null}
      onChoose={async (path) => {
        const folders = (librarySources.data?.folders ?? []).map(
          ({ configuredPath }) => configuredPath,
        );
        const result = await setLibraryFolders({
          environmentId: props.environmentId,
          input: { folders: [...folders, path] },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        librarySources.refresh();
        catalog.refresh();
      }}
    />
  );
}

/** Adds a folder to the Playbook library. */
export function PlaybookFolderPickerScreen() {
  const props = useSettingsFormParams<"SettingsPlaybookFolder">();
  const sources = useEnvironmentQuery(
    j5Environment.playbookSources({ environmentId: props.environmentId, input: {} }),
  );
  const setFolders = useAtomCommand(j5Environment.setPlaybookFolders, { reportFailure: false });
  return (
    <FolderPickerPage
      environmentId={props.environmentId}
      environmentLabel={props.environmentLabel}
      ready={sources.data !== null}
      onChoose={async (path) => {
        const folders = (sources.data?.folders ?? []).flatMap((entry) =>
          entry.source.kind === "folder" ? [entry.source.path] : [],
        );
        const result = await setFolders({
          environmentId: props.environmentId,
          input: { folders: [...folders, path] },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        sources.refresh();
      }}
    />
  );
}

/** Browse the environment's folders (never the phone's) and choose one for a library. */
function FolderPickerPage(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** The folders already configured have loaded; a save replaces the whole list. */
  readonly ready: boolean;
  /** Rejects with the reason the folder wasn't added. */
  readonly onChoose: (path: string) => Promise<void>;
}) {
  const navigation = useNavigation();
  const serverConfig = useServerConfigs().get(props.environmentId);
  const platform = browsePlatform(serverConfig?.environment.platform.os);
  const [pathInput, setPathInput] = useState(() =>
    getAddProjectInitialQuery(serverConfig?.settings.addProjectBaseDirectory),
  );
  const browsePath = useMemo(
    () => getFilesystemBrowsePath(pathInput, platform),
    [pathInput, platform],
  );
  const browseState = useEnvironmentQuery(
    browsePath.directoryPath.length === 0
      ? null
      : filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath },
        }),
  );
  const { visibleEntries, exactEntry } = useMemo(
    () => filterFilesystemBrowseEntries(browseState.data?.entries ?? [], browsePath.filterQuery),
    [browsePath.filterQuery, browseState.data?.entries],
  );
  const selection = exactEntry?.fullPath ?? browseState.data?.parentPath ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose() {
    if (selection === null || saving || !props.ready) return;
    setSaving(true);
    setError(null);
    const result = await settlePromise(() => props.onChoose(selection));
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (navigation.isFocused()) navigation.goBack();
  }
  return (
    <SettingsFormScreen title="Choose a library folder">
      <Text className="px-2 text-sm text-foreground-muted">
        Folders on {props.environmentLabel}. Open a folder to browse into it, then choose it.
      </Text>
      <SettingsSection footer={selection ?? "Enter a folder path to browse."}>
        <FormTextRow
          label="Folder path"
          autoCapitalize="none"
          autoCorrect={false}
          value={pathInput}
          disabled={saving}
          onChangeText={setPathInput}
        />
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label="Choose folder"
        tone="primary"
        fullWidth
        loading={saving}
        disabled={selection === null || !props.ready}
        onPress={() => void choose()}
      />
      <SettingsSection title="Browse folders">
        {browsePath.canBrowseUp && browsePath.parentPath ? (
          <ListRow
            label=".."
            icon="arrow.turn.left.up"
            disabled={saving}
            onPress={() => setPathInput(browsePath.parentPath!)}
          />
        ) : null}
        {browseState.error ? (
          <Text className="px-4 py-3 text-sm text-danger-foreground">{browseState.error}</Text>
        ) : browseState.isPending && browseState.data === null ? (
          <View className="items-center py-5">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : visibleEntries.length === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">No subfolders.</Text>
        ) : (
          visibleEntries.map((entry, index) => (
            <View
              key={entry.fullPath}
              className={cn(
                (index > 0 || browsePath.canBrowseUp) && "border-t border-border-subtle",
              )}
            >
              <ListRow
                label={entry.name}
                icon="folder"
                selected={entry.fullPath === selection}
                disabled={saving}
                onPress={() =>
                  setPathInput(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                }
              />
            </View>
          ))
        )}
      </SettingsSection>
    </SettingsFormScreen>
  );
}
