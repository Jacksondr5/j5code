# Install J5 Code

J5 Code runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first. You need
an installed, authenticated [provider](../../user/install.md#providers) before
starting a thread; you can launch J5 Code and configure providers afterwards.

J5 Code is built on T3 Code and installs separately from it. T3 Code's install
guide, `t3.codes/install.sh`, and packages named T3 Code install upstream T3 Code,
not J5 Code.

## Command line

J5 Code publishes a self-contained server for macOS (Apple silicon) and Linux
x64. It needs no Node.js or npm:

```bash
curl -fsSL https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh | sh
```

This puts `j5` in `~/.local/bin` and keeps downloaded versions and your data in
`~/.j5code` (set `J5CODE_HOME` to use another directory). If `~/.local/bin` isn't
on your `PATH`, the installer adds one line to your shell's startup file (zsh,
bash, or fish) that puts the directory at the end of `PATH`, so `j5` works in new
terminals. `j5 uninstall` removes that line, and the `j5` link the desktop app's Settings
placed in `/opt/homebrew/bin`, `/usr/local/bin` or `~/bin`. If it can't write to
that folder it says so and leaves the link for you to delete. For other shells, add the directory
yourself. To keep the installer away from your startup files, set
`J5CODE_NO_MODIFY_PATH=1` when you run it; it prints the directory to add. Set
`T3CODE_CHANNEL=nightly` to install the nightly train, or `T3CODE_VERSION` to pin an
exact version.

Upgrading a server that was installed from npm (`@jacksondr5/j5code` 0.0.43 or
earlier)? Follow [Migrating to release archives](./migrating-to-release-archives.md)
once; later updates use `j5 update`.

| Task                                             | Command                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Start the server and open the web app            | `j5`                                                                             |
| Start the server without a browser               | `j5 serve`                                                                       |
| Keep it running in the background (macOS, Linux) | `j5 service install` ([details](../../user/background-service.md))               |
| Move to the newest release                       | `j5 update`                                                                      |
| Reclaim database space                           | `j5 doctor` ([details](../../user/background-service.md#reclaim-database-space)) |
| Remove it again                                  | `j5 uninstall`                                                                   |

Run `j5 --help` for the full reference. To start in a new working
directory, use an explicit path such as `j5 ./my-project`. A bare directory name
is accepted only if it already exists.

If `j5` or `j5 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Other platforms

There is no `j5` executable for Intel Macs, Linux on ARM, or Windows. To run a
server there, build it from source with `vp`, which provides the Node version it needs
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

Agents and terminals the app runs can use the `j5` command without any setup: the
app keeps a launcher for its built-in CLI at `~/.j5code/bin/j5` and gives them that
directory. The app doesn't change your own `PATH` or shell startup files unless
you ask.

### The `j5` command

The desktop app includes the `j5` command-line tool. To run it from your own
terminal, open **Settings → About** and choose **Install** next to
**j5 command**. It adds a `j5` link to a folder on your `PATH`; on Windows it adds
the app's command folder to your `PATH`. Open a new terminal afterwards.
**Remove** takes it off again. If another `j5` already runs first in your
terminal, such as one from the command-line installer, the app tells you and
leaves it as it is.

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

J5 Code has no app in the App Store or Google Play. The store apps, TestFlight
builds, and Android betas in T3 Code's guide are T3 Code's.

## Next steps

T3 Code's guides cover the rest of J5 Code; [Using T3 Code's guides](./t3-code-guides.md)
lists where J5 Code differs from them.

- [Providers](../../user/install.md#providers): install and sign in to the agents you use.
- [Working with threads](../../user/thread-sidebar.md): start tasks and organize parallel work.
- [Remote access](../../user/remote-access.md): connect from another device.
- [Running in the background](../../user/background-service.md): keep a Linux or macOS host available.
- [Updating](../../user/updating.md): update the app and connected servers.
