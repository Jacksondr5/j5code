# Skills

On web and desktop, open **Settings → Skills** and select the environment
that should install the skills. Catalog installation and the Installed inventory support Codex and
Claude instances and their configured homes. Mobile can use installed skills in
chat but does not have this settings page.

The Installed section shows each provider instance's discovered skills and their
sources. Choose a project to inspect its workspace discovery, or the environment
view for user skills. When settings apply to one project, the inventory stays on
that project; switch the settings scope to All projects to pick another. Refresh
after editing skill files outside the app. A missing or failed discovery result
does not prove that a skill is unavailable.

Cursor, Grok, OpenCode and Antigravity keep their existing composer discovery;
this settings inventory does not add management controls for those providers.

Choose a trusted Git repository or an absolute catalog folder on that environment.
For a private Git source, use SSH or the host's credential helper; URLs with embedded credentials are rejected.
No source is configured by default. A catalog contains `catalog.yaml` with named
groups and `skills/<name>/SKILL.md`. Apply your group selection to install it;
apply an empty selection to remove the catalog links. Update pulls the configured
Git source, then Apply reconciles any changed groups. Running provider sessions
may need restarting to discover changes.

Catalog skills are installed as links, so keep the catalog folder in place. Ownership belongs
to the environment that created each link, while provider skill folders can be
shared by several environments on one machine. When Apply reports a conflicting link,
choose **Use this catalog…** to review its current and replacement targets. Confirm
only the links you want to move, including links whose old folder is missing. This
changes the shared provider link for every environment using it; source folders
are kept. Existing files and directories cannot be replaced this way. Remove owned
links before deleting the environment's state or its catalog folder.

Use **Link…** on a standalone skill to link its whole folder to another Codex or
Claude instance in the same environment. Choose user scope or an existing project,
then review the destination and compatibility warnings. Catalog installation stays
user-scoped; project scope is available only for individual links. Project links
land inside the selected project's repository and point to absolute paths: heed
the Git warning and exclude the destination before committing. The link does
not copy files or install a plugin's other components.

Choose **Unlink…** on a standalone skill to remove a Codex or Claude link, or
**Unlink all** to remove every link shown for that skill in the selected user and
project scopes. This includes links created elsewhere and works after restarting.
The shared source folder stays in place. Providers sharing a destination are
unlinked together. **Managed links** keeps broken links created here available
for removal. If a managed destination was changed elsewhere, **Forget record**
removes only its ownership record and leaves all files in place.

When no links remain, an original Personal or Project skill can be permanently
deleted after reviewing its folder path and confirming the warning. Deletion
removes that folder and all its files from the environment's machine; it cannot
be undone. Built-in and plugin skills remain read-only.
