# Configure an environment's persona library

Persona files live on the server environment, including when clients connect remotely. Use that environment's active state directory; never point a development server at an installed application's live state.

## Import from a client

Settings → Agents provides one **Import** menu with **Agent file** and **Folder** options on web, desktop, iOS, and Android. Folder selection includes `.yaml` and `.yml` files recursively; a single-file selection imports only that definition. The client uploads selected definition contents to the chosen environment using authenticated orchestration-operate RPCs. Paths are diagnostic labels, never server write destinations.

Imports are copies, stored as one atomically replaced `<stateDir>/imported-agent-personas.json` collection. Imported IDs take precedence over the source library below. The UI first imports with `replaceExisting: false`. Existing IDs produce a typed `AgentPersonaImportConflictError` before any writes, carrying names, IDs, and definition digests. Cancel rejects the entire selection. Each conflict has a replacement toggle. Import selected retries the same files with `replaceExisting: true`, the approved `confirmedConflicts`, and `skippedPersonaIds` for toggled-off agents; the server checks those digests under the mutation permit and requests fresh confirmation for new or changed conflicts. Skipped IDs are excluded before conflict checks and writes, even if their definitions were removed while the dialog was open. They stay skipped across retries. New agents are imported alongside approved replacements; an entirely skipped selection succeeds without writing. Acceptance overwrites local edits only for approved replacements while preserving enabled state and saved task snapshots. The RPC retains explicit replacement without `confirmedConflicts` for existing clients; duplicate IDs within a batch are always rejected. All files are validated before writing. Batches are limited to 50 files and 64 KiB of UTF-8 per file. Other file extensions are ignored; unrelated or malformed JSON/YAML fails the entire selection.

Each imported record has an optional `enabled` flag in the stored collection; absent means enabled for compatibility. Settings exposes this as **On/Off**. Disabled IDs remain in the catalog with unavailable reason `disabled` and are rejected at new persona launch preparation. Replacing a definition preserves its enabled state. The flag is environment metadata and is excluded from definition snapshots and digests. Toggle, import, and removal writes share the same process-wide permit and atomic file replacement.

The destructive trash action uses the authenticated `removeAgentPersona` RPC for every library entry. It records the ID in `<stateDir>/removed-source-agent-personas.json` before deleting any imported copy and its enabled flag. This order prevents a removed override from exposing its source definition. The original source files and task snapshots are untouched. Removed source and bundled definitions remain in the catalog as `removed` entries with `unavailable`/`removed` availability, and the `restoreSourceAgentPersona` RPC (orchestration-operate) deletes the ID from that file so the definition is listed and launchable again. Imported copies have no restore because their content lived only in the deleted import. Imported copies take precedence over exclusions, so importing the original definition explicitly restores an entry. Include both library state files in environment backups. Removal shares the mutation permit with imports and toggles. Legacy import-only and source-only removal RPCs remain for existing clients; the current UI uses complete library removal.

The **Create agent** dialog submits `createAgentPersona` (orchestration-operate): the server builds a version-1 definition with a declared `Response` artifact, a single allowed authority policy, and the chosen route, rejects IDs already present in the catalog or the removed list, and stores it in the imported collection with the enabled flag on. `readAgentPersona` (orchestration-read) returns the stored definition of any listed agent plus a YAML rendering and file name; the editors load instructions from it on open, and the Duplicate and Export actions use it. The pencil editor saves name, description, instructions, runtime policy, and the primary/fallback model targets through `editImportedAgentPersona` with orchestration-operate authorization. The catalog includes editable model targets and a content digest for imported entries only, never raw instructions. A stale digest or missing imported ID rejects the save. Successful edits increment the definition version, validate the complete definition and 64 KiB limit, preserve its enabled flag and unedited fields, and atomically replace only the imported collection. Changing the runtime policy replaces the allowed-policy list with that policy; leaving it unchanged preserves the existing list. Source files and saved task snapshots are untouched.

## Read server folders directly

By default, the server reads `.yaml` and `.yml` files anywhere under `<stateDir>/personas`, walking subfolders in sorted order and skipping dot-directories such as `.git`. If neither that folder nor explicit configuration exists, it offers the bundled examples. An existing empty folder is an intentionally empty library.

To select other folders, create `<stateDir>/agent-personas.json`:

```json
{
  "folders": ["personas", "/absolute/path/to/team-personas"]
}
```

Relative paths resolve from the state directory. Explicit configuration replaces the default/example catalog. An empty `folders` list disables source definitions; client imports remain available. The server never clones, fetches, pulls, or commits; maintain the folders using an editor and git as desired.

Settings → Agents → **Library sources** edits the same file through `getAgentPersonaLibrarySources` (orchestration-read) and `setAgentPersonaLibraryFolders` (orchestration-operate). The read RPC reports each configured entry with its resolved path, whether it exists, and a count of YAML files in its tree, plus a read-only git summary when `git` is on the server's PATH and the folder is inside a repository: the repository root, whether `git status -- .` shows uncommitted changes under that folder, and how many commits the tracked upstream is ahead (from the last fetch; the server does not fetch). The write RPC deduplicates entries, creates missing folders that resolve inside the state directory, rejects missing folders elsewhere and any non-directory before writing, and replaces the file atomically under the shared mutation permit. The catalog marks every entry's origin as `bundled`, `imported`, or `folder` with its source file path.

`getAgentPersonaUsage` (orchestration-read) aggregates saved-agent history from the existing orchestration projections at request time: threads whose payload carries an `agentPersonaAssignment` (deleted threads excluded, archived included), their runs by status with the mean duration of completed runs, per-turn provider token reports summed per agent, and the pinned driver/model routes with thread counts. Nothing is persisted; the queries read `payload_json` through SQLite's `json_extract` on the projection tables, so they cost a scan of those tables per Settings open and should not be polled.

Each YAML file in the folder tree contains one definition; subfolders are only for organisation and carry no meaning. YAML uses version 1.2; duplicate keys, multiple documents, custom tags, and aliases are rejected. JSON definition files are ignored in source folders and rejected on import; only the internal import store, configuration, and snapshots remain JSON. For example, `agent.yaml`:

```yaml
id: team-researcher
version: 1
displayName: Team Researcher
description: Collects evidence for the team.
acceptedInput: A question and relevant repository evidence
inputArtifacts: []
outputArtifact: ContextBrief
authority:
  defaultPolicy: read-only
  allowedPolicies: [read-only]
modelRoute:
  - driver: codex
    model: gpt-5.6-terra
    reasoningEffort: high
  - driver: claudeAgent
    model: claude-opus-5
    reasoningEffort: high
instructions: |-
  # Identity
  You collect evidence for the team.

  # Operating principles
  Cite sources and distinguish observations from inference.
```

Choose exact models and reasoning values advertised by the environment. The server supports Codex and Claude persona policies; other adapters remain unavailable for activation in this revision. `diagnostic` and `publish-only` are blocked pending the required operation boundaries.

Copy and customize the starter files in `apps/server/src/j5/agents/examples/` when working from the repository. Source folders may be shared through git. The source format is identical for starter and custom personas. The file limit is 64 KiB, with 32,768 characters available for instructions. Declare custom handoff names in an optional `artifacts` array before referencing them in `inputArtifacts` or `outputArtifact`.

Reopen Settings → Agents to read the updated catalog, or launch a new persona through the existing orchestrator contract. The server reads files on each catalog request and new activation; a restart is unnecessary. Empty libraries display an empty state. Missing configured folders, malformed files, undefined artifact references, or duplicate ids fail the library read and prevent new persona launches. Fix the indicated source and retry.

Changing the configuration or a source file does not modify running tasks. Every new assignment records a content digest and has an immutable definition snapshot under `<stateDir>/agent-persona-snapshots`. Back up and restore that directory alongside the event database. A missing or corrupt snapshot blocks reuse rather than silently substituting current instructions. Do not prune snapshots while tasks or their forks may reference them. Ordinary non-persona tasks are unaffected by library errors.

Direct human persona selection is available from the composer; in-app git commit, push, and pull remain out of scope by design (the app surfaces status only and opens the folder in an editor).
