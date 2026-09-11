import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";

/** Mirrors the platform mapping the command palette uses for path browsing. */
function browsePlatform(os: string | null | undefined): string {
  return os === "windows" ? "Win32" : os === "darwin" ? "MacIntel" : "Linux";
}

/**
 * Pick a folder on the environment's machine, not the browser's, by walking the same
 * server directory listing the add-project flow uses. The chosen path is the resolved
 * absolute directory, so `~` never reaches the library configuration.
 */
export function AgentFolderPickerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onSelect: (path: string) => void;
}) {
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
  // A typed name that matches a listed folder selects that folder; otherwise the listed directory.
  const selection = exactEntry?.fullPath ?? browseState.data?.parentPath ?? null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a library folder</DialogTitle>
          <DialogDescription>
            Folders on {props.environmentLabel}. Open a folder to browse into it, then choose it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          <Input
            value={pathInput}
            aria-label="Folder path"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPathInput(event.target.value)}
          />
          <div
            role="listbox"
            aria-label="Folders"
            className="max-h-72 overflow-y-auto rounded-md border border-border"
          >
            {browsePath.canBrowseUp && browsePath.parentPath ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => setPathInput(browsePath.parentPath!)}
              >
                <CornerLeftUpIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                ..
              </button>
            ) : null}
            {browseState.error ? (
              <p className="px-3 py-2 text-sm text-destructive-foreground">{browseState.error}</p>
            ) : browseState.isPending && browseState.data === null ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Reading folders…</p>
            ) : visibleEntries.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No subfolders.</p>
            ) : (
              visibleEntries.map((entry) => (
                <button
                  key={entry.fullPath}
                  type="button"
                  role="option"
                  aria-selected={entry.fullPath === selection}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent/60"
                  onClick={() =>
                    setPathInput(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                  }
                >
                  <FolderIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {selection ?? "Enter a folder path to browse."}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={selection === null}
            onClick={() => selection && props.onSelect(selection)}
          >
            Choose folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
