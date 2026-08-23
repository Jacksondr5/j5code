---
title: "T3 Code — feature inventory"
kind: spec
---

# Feature inventory

Every user-facing feature on `main` @ `c9063f03e`, with a short note on how each works. The authoritative machine-readable list of what a client can do is `WS_METHODS` + `ORCHESTRATION_WS_METHODS` in `packages/contracts/src/rpc.ts` and `packages/contracts/src/orchestration.ts` — roughly 90 RPC methods, 10 of them server streams.

## Providers / harnesses — settled

**Five built-in drivers**, registered in `apps/server/src/provider/builtInDrivers.ts` as `BUILT_IN_DRIVERS`:

| Driver kind   | CLI it wraps         | Transport                                                                      |
| ------------- | -------------------- | ------------------------------------------------------------------------------ |
| `codex`       | Codex CLI            | `packages/effect-codex-app-server` (app-server protocol)                       |
| `claudeAgent` | Claude Code          | `ClaudeAdapter` + capabilities probe, Claude home/skills/executable resolution |
| `cursor`      | Cursor CLI (`agent`) | **ACP** via `packages/effect-acp`                                              |
| `grok`        | Grok Build CLI       | **ACP** via `packages/effect-acp`                                              |
| `opencode`    | OpenCode             | `opencodeRuntime.ts` + CLI parsers                                             |

Anything configured but not in the array surfaces as an `"unavailable"` shadow snapshot rather than vanishing. Multiple _instances_ per driver are supported (`ProviderInstanceId`), which is how multi-account Codex and Claude work (`docs/user/providers-codex.md`, `providers-claude.md`).

Users bring their own subscriptions; T3 sells nothing and stores no provider credentials of its own — it drives the CLIs already authenticated on the machine.

## Core chat & agent control

- **Threads.** The durable unit: messages, activities, checkpoints, session state. Created per project, optionally bound to a git worktree. `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, `thread.session.stop`.
- **Turns.** One user-to-agent cycle. A turn ends when the session leaves `running` — checkpoint work settling later does not redefine turn end (`settledTurnStateForSessionStatus` in `projector.ts`).
- **Runtime (permission) modes** — four: `approval-required`, `auto-accept-edits`, `auto`, `full-access`. Set per thread via `thread.runtime-mode.set`. Documented for users in `docs/user/permission-modes.md`.
- **Interaction modes** — `default` and `plan`. Plan mode produces a **proposed plan** card (`thread.proposed-plan.upsert`) with a follow-up banner in the composer.
- **Approvals & user input.** The agent can request approval (`thread.approval.respond`) or freeform input (`thread.user-input.respond`); both render as dedicated composer panels rather than inline chat.
- **Assistant delivery modes** — `streaming` or `buffered`. Buffered accumulates text instead of emitting each delta, spilling as one delta when the accumulation would exceed **24,000 chars** (`MAX_BUFFERED_ASSISTANT_CHARS`), and flushing at approval and user-input boundaries. This is a deliberate websocket-traffic control.
- **Model picker** with per-instance model lists, provider option selections, reasoning-effort selection, and a traits picker.
- **Context window meter** in the composer.
- **Thread title regeneration** — server-side text generation (`apps/server/src/textGeneration/`).

## Thread inbox / managing many threads

This is T3's answer to "I have a lot of agents running":

- **Pin** (with explicit reorder — `thread.pin.reorder`, backed by a `pin_order_key` column), **snooze/unsnooze**, **settle/unsettle**, **archive/unarchive**, delete. AGENTS.md makes the reverse state mandatory: _"Snooze needs unsnooze. Close needs reopen. A one-way door is a bug."_
- **Thread search** (`orchestration.searchThreads`) and a documented thread sidebar (`docs/user/thread-sidebar.md`) with project grouping.
- **Status indicators** per thread in the sidebar, driven by projected session status rather than inferred from cached data.
- **Archived shell snapshots** (`orchestration.getArchivedShellSnapshot`) so archived work is still readable.

## Multi-agent fleet view

The **Agents right panel** (`apps/web/src/components/AgentsPanel.tsx`) — the roster of subagents and workflows the provider spawned. Covered in detail in [multi-agent-and-providers](./multi-agent-and-providers.md). Short version: stable spawn order, three fixed lines per agent row so data changes never change row height, static status dots, DOM-write elapsed timers, collapsible workflow groups with a phase rail, and a read-only workflow **script** viewer served through `orchestration.getWorkflowScript` rather than a client filesystem read.

## Version control

- **Checkpointing.** Each turn is bracketed by workspace checkpoints stored as **hidden git refs** via the VCS driver (`CheckpointStore.ts`). This powers exact per-turn diffs and `thread.checkpoint.revert`, which reverts _both_ the workspace and the provider conversation.
- **Turn diff and full-thread diff** (`orchestration.getTurnDiff`, `getFullThreadDiff`), rendered with `@pierre/diffs` through a **worker pool** (`DiffWorkerPoolProvider.tsx`) so diff computation stays off the main thread.
- **Worktrees** — create/remove per thread (`vcs.createWorktree`), so parallel threads get isolated working trees.
- **Branch toolbar** — branch selector, environment selector, env-mode selector.
- **Stacked git actions** (`git.runStackedAction`, a _streaming_ RPC), plus pull, refresh status, list refs, create ref, switch ref, init.
- **Live VCS status** via `subscribeVcsStatus`.
- **Source control integrations** (`docs/user/source-control.md`): repository lookup, clone, publish.

## Pull request client

A full GitHub PR review surface inside the app — 16 RPC methods:

list, list stats, detail, activity, per-file diff contents, run action, update, comment, update comment, **submit review**, reply to thread, set thread resolution, set reaction, invalidate, reviewer candidates, request reviewers.

Plus `git.resolvePullRequest` and `git.preparePullRequestThread` — you can open a PR and hand it to an agent as a thread. Review comments compose into the chat composer (`ComposerPendingReviewComments.tsx`).

## Terminals

- Server-owned PTYs. `terminal.open/attach/write/resize/clear/restart/close`, with `terminal.attach` as a server stream and separate `subscribeTerminalEvents` / `subscribeTerminalMetadata` streams.
- **Rendering bypasses React entirely.** Web and Android both use the official `libghostty-vt` C ABI — WASM on web drawing into a Canvas 2D surface, JNI on Android — for parsing, terminal state, grapheme boundaries, keyboard encoding, selection, and scrollback. One pinned upstream revision in `native/libghostty-vt/VERSION` for both. See `docs/architecture/terminal-renderers.md`.
- Terminal output can be attached to the composer as context (`ComposerPendingTerminalContexts.tsx`).
- Terminal link detection, split terminals sharing one compiled WASM module per browser tab.

## Browser preview

- `preview.open/navigate/resize/refresh/close/list/reportStatus` plus a **preview automation** channel (`previewAutomation.connect` as a stream, `respond`, `focusHost`).
- Element annotation: you can annotate elements in the preview and they become composer context (`ComposerPreviewAnnotationCards.tsx`, `ComposerPendingElementContexts.tsx`) — point at a bug in your running app and hand it to the agent.
- Mini-player / picture-in-picture preview on desktop (`preview-pip-preload.ts`, `previewMiniPlayerStore.ts`).
- In-app browser with favicon and history stores.

## Files & search

- `projects.listEntries / readFile / writeFile / searchEntries / searchContents`, `filesystem.browse`, `shell.openInEditor` (opens in your real editor — VS Code / JetBrains icons are shipped).
- File preview panel with line reveal, file tag chips and `@`-mention path search in the composer.

## Usage & cost

A **Usage page** combining Codex and Claude Code activity across connected environments by reading the providers' local session history: API-equivalent token cost, processed tokens, cache savings, provider shares, model breakdowns. Ranges: past 24h (hourly), 7/30/90 days (daily). `server.getUsageSummary`.

## Diagnostics & resource telemetry

- `server.getTraceDiagnostics`, `getProcessDiagnostics`, `getProcessResourceHistory`, `getResourceTelemetryHistory`, `retryResourceTelemetry`, `signalProcess` (you can signal a runaway process from the UI), plus a `subscribeResourceTelemetry` stream.
- Backed by a **standalone Rust executable** (`native/resource-monitor`, `sysinfo`) that replaced recurring `ps`/PowerShell/`ioreg`/`pmset` subprocess probes, holding bounded in-memory history that the server only merges on request. Electron main-process APIs supply Electron metrics and host power state.

## Settings, theming, input

- Settings surface with connections management, provider instance config, appearance, keybindings, theme editor, font family picker.
- **Themes**: theme palette editor, **VSCode theme import**, OpenVSX theme fetching.
- **Keybindings**: server-persisted (`server.upsertKeybinding` / `removeKeybinding`), documented in `docs/user/keybindings.md`.
- **Command palette** with its own logic module and result ranking.
- **Project settings**: custom project icon/favicon, project scripts (`projectScriptEditor.tsx`), `t3.json` project file.
- Background activity policy (`server.getBackgroundPolicy`, `subscribeBackgroundPolicy`), client activity reporting, host power state reporting — the server adapts behavior to whether anyone is watching and whether the host is on battery.

## Remote access

Five access methods and a full relay. See [remote](./remote.md). User-facing entry points: pairing URLs and pairing codes, QR code pairing, a connections list, Tailscale endpoints, T3 Connect sign-in, and desktop-managed SSH environments.

## Surfaces

- **Web** — React/Vite, served both by `npx t3` locally and hosted at `app.t3.codes`.
- **Desktop** — Electron, wraps the same web bundle and bundles the server runner; can itself act as the host server for remote clients. Auto-update with a Windows fast-path, WSL path handling, Linux secret storage, native passkeys.
- **Mobile** — React Native (iOS + Android, both stores). Feature dirs: agent-awareness, archive, cloud, connection, diffs, files, home, keyboard, layout, observability, projects, review, settings, sharing, shortcuts, terminal, threads, updates, usage. Native composer editors per platform, native keyboard commands on iOS, native glass/sheet surfaces, and an **`AgentActivity` widget** (iOS Live Activity — agent progress on the lock screen / Dynamic Island, delivered via APNs from the relay).
- **Marketing** site (`apps/marketing`).

## Server updates & lifecycle

Server can update itself (`server.updateServer`, `updateServerWithProgress` as a stream), advertise its version to clients, and coordinate version skew so remote environments stay online while clients move to newer releases (`docs/internals/server-updates.md`, `versionSkew.ts`). Linux background service install/update/uninstall (`t3 service`). Local server discovery via `subscribeDiscoveredLocalServers`.
