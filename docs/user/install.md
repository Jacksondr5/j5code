# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

J5 Code publishes a self-contained server for macOS (Apple silicon) and Linux
x64. It needs no Node.js or npm:

```bash
curl -fsSL https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh | sh
```

This puts `j5` in `~/.local/bin` and keeps downloaded versions and your data in
`~/.j5code` (set `J5CODE_HOME` to use another directory). If your shell reports
`command not found` afterwards, that directory is not on your `PATH` yet; the
installer prints the line to add. Set `T3CODE_VERSION` to pin an exact version.

Upgrading a server that was installed from npm (`@jacksondr5/j5code` 0.0.42 or
earlier)? Follow [Migrating to release archives](./migrating-to-release-archives.md)
once; later updates use `j5 update`.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `j5`                                                      |
| Start the server without a browser               | `j5 serve`                                                |
| Keep it running in the background (macOS, Linux) | `j5 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `j5 update`                                               |
| Remove it again                                  | `j5 uninstall`                                            |

Run `j5 --help` for the full reference.

### Other platforms

There is no `j5` executable for Intel Macs, Linux on ARM, or Windows. To run a
server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/Jacksondr5/j5code#install-vp)):

```bash
git clone https://github.com/Jacksondr5/j5code
cd j5code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`j5 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download the macOS (Apple silicon) app from
[GitHub Releases](https://github.com/Jacksondr5/j5code/releases). J5 Code
publishes no desktop build for other platforms and no package-manager listing;
`winget`, Homebrew, and AUR packages named T3 Code install upstream T3 Code.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
j5 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `j5 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                            |
| Pi          | Install [Pi](https://pi.dev), then run `pi` once to finish its login or API-key setup.       |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T3 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), and [Pi](./providers-pi.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
