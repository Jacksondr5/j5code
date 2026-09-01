# PR #35 final live evidence

Source PR head: `af0d55cf0750595d01a174f4e691be5ce02ab7d3`.

All captures were made on the final source head in isolated disposable local environments. The PNG files below were verified with `file` as true PNG payloads after capture.

## Screenshot claims

| File | Live claim |
| --- | --- |
| `01-two-squadrons-one-folder.png` | Alpha and Bravo are distinct Squadron choices despite sharing one folder; picker rows contain the names only. |
| `02-bravo-selection-avoids-alpha-thread.png` | Choosing Bravo creates a Bravo-scoped draft rather than navigating to Alpha's existing same-folder thread. |
| `03-chat-new-opens-squadron-picker.png` | `chat.new` opens the Squadron picker for two Squadrons over one folder. |
| `04-chat-new-local-opens-squadron-picker.png` | `chat.newLocal` opens the same Squadron picker. |
| `05-chat-header-divergent-folder-solo-carrier.png` | ChatHeader from active F2 creates the Solo/F1 carrier draft, not an F2 draft. |
| `06-index-sole-squadron-f1-carrier.png` | Index auto-launch with sole Solo/F1 selects that carrier despite most-recent F2. |
| `07-index-two-squadrons-explicit-choice.png` | Index with Alpha and Bravo over one folder remains in explicit choice state and does not auto-launch. |
| `08-sidebar-branch-source-home-carrier.png` | Sidebar branch action keeps the F2 source worktree while the new draft's carrier is its Registrar home Solo/F1. |
| `09-zero-squadron-new-thread-creates-squadron.png` | Ready-with-zero state exposes the Create Squadron path rather than an empty picker. |
| `10-all-squadrons-scope-dropdown.png` | Ambient scope menu renders the reviewed `All Squadrons` label and its Squadron choices. |

## DOM/text-only accessibility assertion

`11-squadron-create-form-accessible-name.txt` is **not a screenshot claim**. It records the browser DOM query for the Create a Squadron dialog: the one matching control has accessible name and visible text `Choose folder`.

## Integrity

`SHA256SUMS` contains checksums for every published PNG and the DOM assertion file.
