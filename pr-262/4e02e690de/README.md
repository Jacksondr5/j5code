# PR #262 client pass (web), head 4e02e690de

The PR build ran as a dev server on openclaw against a `VACUUM INTO` copy of the live J5 database, and was driven by headless Chromium at 1440×900. The migration bridge upgraded the September-shaped history on the copy (`J5 upgraded upstream migration history`), applying 51–53 and 55.

| Shot | What it shows |
|---|---|
| 01 | Landing: upstream's one-row sidebar header, Squadron names on thread cards, agent expanders |
| 02 | Squadron scope picker in upstream's `SidebarThreadHeader` scope slot |
| 03 | Upstream's revived header thread menu |
| 04 | Sidebar "New thread" with several Squadrons opens the Squadron picker |
| 05 | Upstream steering UI ("Steer" badge on a steered message) |
| 06 | Thread details panel, Lineage section (upstream subagents; J5 rows tracked in #283) |
| 07 | J5 inbound A2A card ("From … · Expects reply") |
| 08 | Upstream "Sent by another agent" attribution |
| 09 | Upstream's collapsed-composer drawer when scrolled (unmodified upstream `ComposerSurface`) |
| 10 | Fleet page (51 agents across 3 Squadrons) |
| 11 | Inbox |
| 12 | Settings → General, including upstream's usage-limit auto-resume and snooze toggles |
| 13 | Settings → Personas library |
| 14 | Sidebar agents expander |
| 15 | Right panel surfaces: Artifacts present, Agents panel removed |
| 16 | Bare `@` ordering: saved agents, then threads, then files |
| 17 | Artifacts panel (empty because the test copy didn't include artifact files) |

Not covered: mobile (no simulator tooling on this host), the desktop app, anything that sends a message (it would start real provider runs), and the real service handover. The Squadron-less "New thread" in the landing shot comes from upstream's pre-existing web-mode auto-bootstrap (see the linked issue).
