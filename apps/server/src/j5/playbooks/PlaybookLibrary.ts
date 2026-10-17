import {
  PLAYBOOK_NAME_PATTERN,
  PlaybookFoldersInput,
  type PlaybookSource,
  type PlaybookError,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { decodePlaybookDocument, playbookError, storageError } from "./definition.ts";

const FileStem = /^[^/\\\p{Cc}]+$/u;
const FolderConfig = Schema.fromJsonString(PlaybookFoldersInput);
const decodeFolders = Schema.decodeUnknownEffect(FolderConfig);
const encodeFolders = Schema.encodeEffect(FolderConfig);

/** Discovery and name lookup use the same environment catalog. */
export const selectPlaybookSource = (
  inventory: ReadonlyArray<{
    source: PlaybookSource;
    path: string;
    issue: PlaybookError | null;
    names: ReadonlyArray<string>;
  }>,
  name: string,
  explicitSource = false,
) => {
  const candidates = inventory.filter((entry) => entry.names.includes(name));
  const entry = candidates[0];
  const issue = explicitSource
    ? null
    : (inventory.find((entry) => entry.issue !== null)?.issue ??
      (candidates.length > 1
        ? playbookError(
            "duplicate_name",
            `Playbook ${name} exists in multiple libraries: ${candidates.map((entry) => entry.path).join(", ")}. Rename a copy or remove a source.`,
          )
        : null));
  return { entry, issue };
};

/** Server-local libraries; callers never supply a filesystem write destination. */
export const makePlaybookLibrary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Effect.serviceOption(ServerConfig);
  const stateDir = Option.isSome(config) ? config.value.stateDir : null;
  const managed = stateDir === null ? null : path.join(stateDir, "playbooks");
  const requireManaged = () =>
    managed === null
      ? Effect.fail(
          playbookError("storage_unavailable", "Environment playbook storage is unavailable."),
        )
      : Effect.succeed(managed);
  const folders = Effect.gen(function* () {
    if (stateDir === null) return [];
    const text = yield* fs
      .readFileString(path.join(stateDir, "playbooks.json"))
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed('{"folders":[]}') : Effect.fail(error),
        ),
      );
    return (yield* decodeFolders(text)).folders;
  });
  const sources = Effect.fn("PlaybookLibrary.sources")(function* () {
    const entries: Array<{ source: PlaybookSource; path: string }> = [];
    if (managed !== null) entries.push({ source: { kind: "environment" }, path: managed });
    const configured = yield* Effect.result(folders);
    for (const folder of configured._tag === "Success" ? configured.success : [])
      entries.push({
        source: { kind: "folder", path: folder },
        path: path.resolve(stateDir!, folder),
      });
    const seen = new Set<string>();
    const result = [];
    for (const entry of entries) {
      const canonical = yield* fs
        .realPath(entry.path)
        .pipe(Effect.catch(() => Effect.succeed(entry.path)));
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const files = yield* Effect.result(fs.readDirectory(entry.path));
      const issue =
        configured._tag === "Failure" && entry.source.kind === "environment"
          ? playbookError(
              "invalid_configuration",
              `Fix ${path.join(stateDir!, "playbooks.json")}: ${String(configured.failure)}`,
            )
          : files._tag === "Failure" &&
              !(entry.source.kind !== "folder" && files.failure.reason._tag === "NotFound")
            ? playbookError(
                "source_unavailable",
                `Cannot read playbook folder ${entry.path}. Fix or remove this library source.`,
              )
            : null;
      result.push({
        ...entry,
        issue,
        names:
          files._tag === "Success"
            ? files.success
                .filter((name) => name.endsWith(".yaml") && FileStem.test(name.slice(0, -5)))
                .map((name) => name.slice(0, -5))
                .sort()
            : [],
      });
    }
    return result;
  }, Effect.mapError(storageError));
  const directoryFor = Effect.fn("PlaybookLibrary.directoryFor")(function* (
    source: PlaybookSource,
  ) {
    if (source.kind === "environment") return yield* requireManaged();
    if (!(yield* folders).includes(source.path))
      return yield* playbookError(
        "source_not_found",
        "This playbook folder is no longer configured.",
      );
    return path.resolve(stateDir!, source.path);
  }, Effect.mapError(storageError));
  const resolve = Effect.fn("PlaybookLibrary.resolve")(function* (
    name: string,
    source?: PlaybookSource,
  ) {
    const stem = name.endsWith(".yaml") ? name.slice(0, -5) : name;
    if (!(source ? FileStem : PLAYBOOK_NAME_PATTERN).test(stem))
      return yield* playbookError(
        "invalid_name",
        "Choose a playbook name from j5_playbook_list: lowercase letters, digits, and hyphens.",
      );
    if (source)
      return {
        stem,
        definitionPath: path.join(yield* directoryFor(source), `${stem}.yaml`),
      };
    const selected = selectPlaybookSource(yield* sources(), stem);
    if (selected.issue) return yield* selected.issue;
    if (!selected.entry)
      return yield* playbookError("not_found", `No playbook named ${stem}. Use j5_playbook_list.`);
    return { stem, definitionPath: path.join(selected.entry.path, `${stem}.yaml`) };
  }, Effect.mapError(storageError));
  const setFolders = Effect.fn("PlaybookLibrary.setFolders")(function* (
    input: typeof PlaybookFoldersInput.Type,
  ) {
    yield* requireManaged();
    const selected = [];
    const seen = new Set<string>();
    for (const raw of input.folders) {
      const folder = raw.trim();
      const absolute = path.resolve(stateDir!, folder);
      const stat = yield* fs
        .stat(absolute)
        .pipe(
          Effect.mapError(() =>
            playbookError("invalid_path", `Folder does not exist or cannot be read: ${absolute}`),
          ),
        );
      if (stat.type !== "Directory")
        return yield* playbookError("invalid_path", `Not a folder: ${absolute}`);
      const real = yield* fs.realPath(absolute);
      if (seen.has(real) || real === managed) continue;
      seen.add(real);
      selected.push(folder);
    }
    yield* writeFileStringAtomically({
      filePath: path.join(stateDir!, "playbooks.json"),
      contents: yield* encodeFolders({
        folders: selected,
      }),
    });
  }, Effect.mapError(storageError));
  const save = Effect.fn("PlaybookLibrary.save")(function* (input: { name: string; yaml: string }) {
    if (!PLAYBOOK_NAME_PATTERN.test(input.name))
      return yield* playbookError(
        "invalid_name",
        "Use lowercase letters, digits, and hyphens, starting with a letter.",
      );
    yield* decodePlaybookDocument(input.yaml);
    const directory = yield* requireManaged();
    yield* fs.makeDirectory(directory, { recursive: true });
    const filename = path.join(directory, `${input.name}.yaml`);
    // An exact-content retry is harmless; no save may replace an existing definition.
    if (yield* fs.exists(filename)) {
      if ((yield* fs.readFileString(filename)) === input.yaml)
        return { name: input.name, saved: false };
      return yield* playbookError(
        "already_exists",
        "A playbook with this name already exists. Choose another name.",
      );
    }
    const inventory = yield* sources();
    if (inventory.some((entry) => entry.names.includes(input.name)))
      return yield* playbookError(
        "already_exists",
        "A library already contains this name. Choose another name.",
      );
    const unavailable = inventory.find((entry) => entry.issue !== null);
    if (unavailable) return yield* unavailable.issue!;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".save-" });
        const staged = path.join(temporary, "definition");
        yield* fs.writeFileString(staged, input.yaml);
        // A hard link atomically publishes a complete file and cannot replace another save.
        yield* fs.link(staged, filename);
        return { name: input.name, saved: true };
      }),
    );
  }, Effect.mapError(storageError));
  return { sources, resolve, directoryFor, save, setFolders };
});
