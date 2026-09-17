---
name: j5-install-skills
description: Select, install, update, or remove user-level skill groups from a local catalog.yaml. Use for the J5 skill installer chat or requests to manage a shared skill catalog.
---

# Install shared skill groups

Work on the chat environment's machine. The project supplies the chat workspace;
installation is user-wide. Reuse choices and authorization already given in this
conversation. Starting the installer alone is a request to list choices.

## Choose groups

1. Use the supplied catalog folder, otherwise read `~/.agents/skill-catalog.json`
   for the previous folder and selection. If neither is available, ask for the local
   folder containing `catalog.yaml` and `skills/<name>/SKILL.md`.
2. Read the catalog as data. Its `groups` map has a description, a `skills` list,
   and an optional `depends` list per group. Show a compact group list with
   descriptions, skill counts, requirements, and the current selection. Let the user
   choose several groups by name, or `none` to uninstall. Apply an explicit selection
   already requested without asking for it again. Installation requires a selection.
3. Resolve transitive dependencies and unique skill names. Reject unknown groups,
   dependency cycles, duplicate skill membership, and names that do not match
   `^[a-z0-9][a-z0-9-]*$`. Verify every selected skill has a `SKILL.md`. Keep original skill names
   so cross-references continue to work. Show the resulting groups and skill count.

## Apply the selection

Use absolute directory symlinks into the catalog's `skills/` folder. On Windows use
directory junctions. Install into both `~/.agents/skills` and `~/.claude/skills`;
`CLAUDE_CONFIG_DIR`, when set, replaces `~/.claude`. Resolve `~` using the environment
user's home. Deduplicate target directories that resolve to the same directory.
Project installations and other provider-specific locations are outside this version.

Read existing entries with `lstat` and `readlink`, including broken links. Before
changing anything, plan additions and removals across both targets and report name
collisions. Preserve foreign files, directories, and links. A collision needs a user
choice; never overwrite it or silently report a skipped skill as installed.

Track ownership in `~/.agents/skill-catalog.json` with this shape:

```json
{
  "folder": "/absolute/catalog",
  "groups": ["core"],
  "links": [
    { "path": "/absolute/user/skills/explain", "target": "/absolute/catalog/skills/explain" }
  ]
}
```

Only remove a recorded link if its current link destination still matches its recorded
target. Resolve relative link text against its parent; do not require the destination
to exist. This allows cleanup after upstream deletion or a catalog move. Unrecorded
entries are foreign. Recheck affected entries immediately before changing them and
stop if they changed since inspection. Preserve manual Claude overrides and Codex
disable settings.

After applying, verify the links and atomically replace the state file with mode 0600.
Record explicitly selected groups, with dependency links included in `links`. If an
operation fails partway, record the links actually created/retained and report the
incomplete operation, so a retry can recover without claiming foreign ownership.
For `none`, remove only recorded matching links and persist an empty selection;
uninstall can use the recorded links even if the catalog is unavailable.

## Update and verify

Choosing groups uses local files and never fetches or pulls. When the user explicitly
requests an update, check the repository's branch/upstream and working tree first.
Preserve local edits; fetch and pull with `--ff-only` only into a clean checkout with
an upstream, then reload the catalog and reconcile the saved selection. Report removed
groups for the user to resolve. Never push as part of installation or updating.

Report installed, removed, unchanged, and conflicting skills from filesystem evidence.
Mention that existing project skills remain available and provider disable settings
can hide installed skills. Refresh the provider's skill list or start a new session
to verify discovery; filesystem links alone do not prove runtime availability.
