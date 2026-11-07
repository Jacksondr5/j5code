# Using T3 Code's guides

J5 Code is built on T3 Code, and most of its features are T3 Code's. Their guides in
[`docs/user/`](../../user) are kept as T3 Code wrote them, so they say "T3 Code" and use T3 Code's
command, folders, and links. They apply to J5 Code with the changes on this page.

Two pages are replaced outright: [Install J5 Code](./install.md) and
[Product usage data](./telemetry.md).

## Names

| T3 Code's guides say                                          | In J5 Code                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `t3`, as in `t3 serve`, `t3 connect`, `t3 service install`    | `j5`, as in `j5 serve`, `j5 connect`, `j5 service install`                       |
| `npx t3@latest`                                               | Not available: J5 Code publishes nothing to npm                                  |
| T3 home, `~/.t3`, `T3CODE_HOME`                               | J5 home, `~/.j5code`, `J5CODE_HOME` (`T3CODE_HOME` is ignored)                   |
| `t3code.service`, `com.t3tools.t3code.service`                | `j5code.service`, `codes.jackson.j5code.service`                                 |
| `~/Library/LaunchAgents/com.t3tools.t3code.service.plist`     | `~/Library/LaunchAgents/codes.jackson.j5code.service.plist`                      |
| The worktree branch prefix `t3/`                              | `j5code/`                                                                        |
| `https://app.t3.codes/new?…` and `t3code://` links            | `https://j5.codes/new?…` and `j5code://` links                                   |
| Releases on `pingdotgg/t3code` and on npm                     | Releases on [`Jacksondr5/j5code`](https://github.com/Jacksondr5/j5code/releases) |
| The App Store, Google Play, TestFlight, and Android beta apps | None: J5 Code has no mobile app in a store                                       |

Other environment variables keep T3 Code's names, such as `T3CODE_HOST`, `T3CODE_CHANNEL` and
`T3CODE_TELEMETRY_ENABLED`. T3 Connect is T3 Code's relay, and J5 Code uses it under that name.

## Updating

[Updating](../../user/updating.md) works as described, except:

- A server update appears once that version's release is published on GitHub
  (`Jacksondr5/j5code`), not on npm.
- A server installed from npm (`@jacksondr5/j5code` 0.0.43 or earlier) cannot update itself to a
  release archive: **Update server** fails because no newer npm version exists. Follow
  [Migrating to release archives](./migrating-to-release-archives.md) on that machine once; later
  updates work from the app and with `j5 update` again.
- Occasionally an update changes how the background service starts, and **Update server** stops
  with a message asking you to run `j5 update` on the server's machine. Run it there once. The
  server keeps running its current version until you do, and later updates work from the app
  again.

## Running in the background

[Running in the background](../../user/background-service.md) works as described, with these
additions:

- J5 releases up to 0.0.43 installed the service as `t3code.service` /
  `com.t3tools.t3code.service`, the same names an installed T3 Code uses. `j5 service install`
  replaces that old service automatically, but only when its unit names `J5CODE_HOME`; a T3 Code
  service is never touched. Settings you added to the old unit, such as systemd drop-ins in
  `t3code.service.d/`, do not move on their own; see
  [Migrating to release archives](./migrating-to-release-archives.md).
- `service.env` cannot override `J5CODE_HOME` either.
- `j5 service install` and `j5 service restart` check that the service is running after they start
  it. If it is not, they report an error instead of success. Read the log they name.
- Where the guide says "a version before 0.1.0", read "a J5 Code version that kept its database in
  `state.sqlite`".

`j5 service status` can report three more problems:

| Status problem              | Next step                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy-service-present`    | The old J5 service from 0.0.43 or earlier (`t3code.service` / `com.t3tools.t3code.service`) is still installed. Run `j5 service install`.                                                 |
| `foreign-service-present`   | A `j5code.service` / `codes.jackson.j5code.service` that J5 did not write already exists. Remove or rename it, then run `j5 service install`.                                             |
| `service-dropin-conditions` | A drop-in in `~/.config/systemd/user/j5code.service.d/` has a `Condition…=` or `Assert…=` line that can make systemd skip the start. Review and remove it, then run `j5 service install`. |

## Remote access over SSH

In [Remote access](../../user/remote-access.md), the desktop app's first SSH launch downloads the
J5 Code server release for the desktop app's version to `~/.j5code/runtime` on the host. The host
must be Linux x64 or an Apple Silicon Mac, the platforms J5 Code publishes.

## Prompt links

[Prompt links](../../user/prompt-links.md) work as described, but **Copy prompt link** makes
`https://j5.codes/new?…` links, and a thread link with a prompt is
`https://j5.codes/<environment>/<thread>?prompt=…`. J5 Code has no hosted app: the j5.codes page
shows the prompt, warns about hidden characters, and offers to open it in the J5 Code app or on
your own server. `app.t3.codes` links are T3 Code's and open in T3 Code.

When J5 Code is your [default browser](../../user/default-browser.md), choose **J5 Code** in System
Settings, and j5.codes prompt links open in the app as a draft.
