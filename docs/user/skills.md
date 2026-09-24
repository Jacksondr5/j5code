# Skills

On web and desktop, open **Settings → Skills** and select the environment
that should install the skills. Catalog installation supports enabled Codex and
Claude instances and their configured homes. Mobile can use installed skills in
chat but does not have this settings page.

Choose a trusted Git repository or an absolute catalog folder on that environment.
For a private Git source, use SSH or the host's credential helper; URLs with embedded credentials are rejected.
No source is configured by default. A catalog contains `catalog.yaml` with named
groups and `skills/<name>/SKILL.md`. Apply your group selection to install it;
apply an empty selection to remove the catalog links. Update pulls the configured
Git source, then Apply reconciles any changed groups. Running provider sessions
may need restarting to discover changes.

Installed skills are links, so keep the catalog folder in place. Ownership belongs
to the environment that created each link, while provider skill folders can be
shared by several environments on one machine. Existing files and links owned
elsewhere are preserved. Remove owned links before deleting the environment's
state or its catalog folder.

