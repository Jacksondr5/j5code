# J5 Code branding boundary

J5 Code keeps upstream's internal names stable and owns only the identifiers that people,
operating systems, installers, and deep-link dispatchers use. Recheck this inventory after every
upstream pin advance.

## Canonical identity

Fork-owned values live in `scripts/lib/j5-branding.ts`:

| Surface                     | Production                                                                                                                                                        | Development / preview                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Display name                | `J5 Code`                                                                                                                                                         | `J5 Code (Dev)`, `J5 Code (Nightly)`, `J5 Code Preview`                                              |
| Desktop / mobile app ID     | `codes.jackson.j5code`                                                                                                                                            | `.dev` and `.preview` suffixes                                                                       |
| URL scheme                  | `j5code`                                                                                                                                                          | `j5code-dev`, `j5code-preview`                                                                       |
| Default desktop state       | `~/.j5code/userdata`                                                                                                                                              | `~/.j5code/dev`                                                                                      |
| Default server state        | `~/.j5code/userdata`                                                                                                                                              | `~/.j5code/dev`                                                                                      |
| Desktop App Support         | `j5code`                                                                                                                                                          | `j5code-dev`                                                                                         |
| Linux executable / WM class | `j5code`                                                                                                                                                          | `j5code-dev`                                                                                         |
| Desktop artifact prefix     | `J5-Code-`                                                                                                                                                        | same                                                                                                 |
| CLI command on PATH         | `j5` (`J5_BRANDING.cli.command`; web `CLI_COMMAND` reads it for WelcomeWizard connect/pair/serve and pairing copy; `packageName` is the historical npm name only) | symlink `~/.local/bin/j5` → `<home>/runtime/versions/<v>/t3` (`install.sh` links the archive's `t3`) |
| Background service          | `j5code.service` (systemd), `codes.jackson.j5code.service` (launchd)                                                                                              | same                                                                                                 |
| CLI release repository      | `Jacksondr5/j5code`                                                                                                                                               | archives `t3-<v>-<platform>.tar.gz`, `SHA256SUMS`, `install.sh`                                      |

The macOS development launcher adds a checkout-derived suffix to the development bundle ID so
multiple J5 checkouts can coexist. Production remains exactly `codes.jackson.j5code`.

## Pin-advance audit sites

- Home resolution: `apps/server/src/cli/config.ts`, `app.ts`, `pair.ts`, `theme.ts`, `triage.ts`,
  `cloud/bootService.ts`, `serviceLauncher.ts`, `packages/shared/src/devHome.ts`, and
  `scripts/dev-runner.ts`. Explicit CLI home outranks worktree isolation; worktree dev
  state outranks an ambient home. Pairing must target the same resolved state.
- SSH runner homes: `packages/ssh/src/tunnel.ts` uses `~/.j5code` for both release-archive runtimes (under
  `~/.j5code/runtime/versions`) and node-script runners; `~/.t3/ssh-launch` remains transport bookkeeping.
- Release archives and installers (FORK.md case 40): `packages/shared/src/cliRelease.ts`
  (`CLI_RELEASE_REPOSITORY`), `scripts/install.sh`, `scripts/install.ps1`, and
  `scripts/smoke-cli-archive.ts` (scratch `J5CODE_HOME`).
- Background service and CLI copy (FORK.md case 41): `apps/server/src/cloud/bootService.ts` and
  `cloud/j5/legacyBootService.ts` (service names), and `apps/server/src/cli/update.ts`, `uninstall.ts`,
  `updateProgress.ts`, and `service.ts` (`j5` strings, cgroup `/j5code.service`, `j5.cmd`).
- Desktop runtime identity and state: `DesktopEnvironment.ts`, `DesktopStatePaths.ts`,
  `DesktopEarlyElectronStartup.ts`, `DesktopAppIdentity.ts`, `DesktopUserData.ts` (profile names;
  never a T3 profile), `wsl/DesktopWslEnvironment.ts` (`~/.j5code/wsl-runtime`), and the user-visible
  app name in `permissions/MacPermissionHelper.ts`.
- Desktop OS integration: `electron-launcher.mjs`, `ElectronProtocol.ts`,
  `DesktopLinuxUrlHandler.ts`, and the server renderer-origin allowlist in `apps/server/src/http.ts`.
- Linux capture: `apps/desktop/src/snapShot/{KdeSnapShot,HyprlandSnapShot,GnomeCaptureSetup,linuxCaptureSession}.ts` and `apps/desktop/gnome-extension/`. These newly adopted integrations still use upstream helper directories, desktop/extension identities and bus names. They can collide with an installed T3 Code; OS integration isolation is incomplete until [#138](https://github.com/Jacksondr5/j5code/issues/138) is resolved.
- Desktop packaging: `apps/desktop/package.json`, `scripts/build-desktop-artifact.ts`, and both DMG
  background SVGs.
- Mobile OS identity and links: `apps/mobile/app.config.ts`, mobile package scripts, `App.tsx`,
  `src/lib/appLinking.ts` (scheme-only `j5code` wake links), pairing QR handling, the Agent Activity
  widget, and the Android subscription-usage widget's fallback deep link in
  `apps/mobile/modules/t3-subscription-widget/android/.../SubscriptionUsageWidget.kt` (a literal
  `j5code://` because Kotlin cannot read `j5-branding.ts`).
- Web fallback identity: `apps/web/src/branding.ts` (including `CLI_COMMAND = "j5"`, the
  release-archive PATH command), `versionSkew.ts` `manualServerUpdateCommand` (`j5 update <version>`),
  the `components/ServerUpdateAction.tsx` success copy, the `components/desktopUpdate.logic.ts`
  release history URL (`Jacksondr5/j5code/releases`), the pre-React boot shell in
  `apps/web/index.html`, and the fork-owned `apps/web/src/j5/branding/J5Wordmark.tsx` connected at
  the sidebar's small `SidebarChrome.tsx` seam (it takes an optional `className`, so the brand uses
  upstream's `h-[1cap]` sizing), and the assistant author heading in
  `components/chat/MessagesTimeline.tsx` `AssistantTimelineRow`, which reads `APP_BASE_NAME` from
  `branding.ts` instead of upstream's literal "T3 Code".
- Shared client copy: `packages/client-runtime` has no branding import, so its user-visible
  strings stay product-neutral instead of naming T3 Code: `connection/compatibility.ts` ("Update the
  server on …") and `state/pullRequestDiffHttp.ts` ("quit and reopen the app").
- New upstream files: the list above names only known sites. On every advance, also grep the files
  upstream added since the old pin for `t3code`, `T3 Code`, `.t3`, `T3CODE_HOME`, `pingdotgg`,
  `t3.codes/install`, and `npx t3`, then rebrand identity sites and leave deliberate internals and
  general copy (below) unchanged.

## Deliberately unchanged upstream internals

- The `T3CODE_*` environment variables other than the base-directory override, which is `J5CODE_HOME`. An ambient `T3CODE_HOME` is ignored, and a linked worktree's dev state lives in `<worktree>/.j5code`, so J5 never shares state with an installed T3 Code (FORK.md case 25).
- Internal workspace/package names such as `@t3tools/*`, `t3`, and upstream lint rule names. The
  release archive and its executable keep the internal `t3` name; the installer's other environment
  names (`T3CODE_CHANNEL`, `T3CODE_VERSION`, `T3CODE_INSTALL_BIN_DIR`, `T3CODE_RELEASE_BASE_URL`), the
  `T3_BOOT_SERVICE_UNIT` key, and the `__service-launcher` subcommand stay upstream's.
- Database schema names, persisted mobile storage keys, internal CLI flags, and code identifiers.
- General upstream product copy and documentation outside the identity sites above, including
  settings copy naming "T3 Code"/"T3 Connect" (`LocalEnvironmentSetting`, `NotificationSettings`,
  `EnvironmentRow`), mobile "About T3 Code"/"Update T3 Code…" and widget descriptions, and the
  `T3Wordmark` icon on t3-code MCP tool rows.

## Cloud and update posture

- Desktop publishing is configured only when `T3CODE_DESKTOP_UPDATE_REPOSITORY` or
  `GITHUB_REPOSITORY` is supplied; the fork does not hard-code an upstream update repository.
- Mobile Expo updates are disabled until Jackson configures J5-owned update infrastructure.
- Mobile builds use the J5-owned Expo project `@jacksondr5/j5-code`, defined in
  `scripts/lib/j5-branding.ts`. `apps/mobile/eas.json` targets Apple team `46A73QH3S8`
  and App Store Connect app `6809314460`; preserve these fork destinations during pin advances.
  See [iOS distribution](docs/operations/j5-mobile-distribution.md).
- Clerk, relay, and telemetry remain optional and use the upstream `T3CODE_*` / `EXPO_PUBLIC_*`
  configuration names. No J5 service endpoints are provisioned by the build setup.

## 2026-09-06 verification boundary

The pin advance rechecked identity/configuration with focused tests and exercised web/server
home isolation in disposable state. Subsequently, the [weekly full build](https://github.com/Jacksondr5/j5code/actions/runs/34064485547)
at source `f8ba1a653f986835d3e5d0584648cc686f16ceb6` built the Apple Silicon desktop
artifact, mounted its DMG read-only, and verified `J5 Code`, `codes.jackson.j5code`, and its
strict ad-hoc signature. That proves packaged identity and signing at that source, not desktop
interaction or packaged-app execution. Mobile native builds/interaction and second-machine,
relay or tunnel acceptance were not performed in this advance. The older native check below
is historical evidence.

## 2026-08-15 empirical isolation check

Installed T3 Code (Alpha) and J5 Code (Dev) ran concurrently on macOS:

| App             | Bundle ID                         | Runtime state    | App Support                  |
| --------------- | --------------------------------- | ---------------- | ---------------------------- |
| T3 Code (Alpha) | `com.t3tools.t3code`              | `~/.t3/userdata` | `t3code` / `T3 Code (Alpha)` |
| J5 Code (Dev)   | `codes.jackson.j5code.dev.j5code` | `~/.j5code/dev`  | `j5code-dev`                 |

The J5 backend logged `~/.j5code/dev/logs`, created `~/.j5code/dev/state.sqlite`, registered the
`j5code-dev` renderer scheme, and listened on its test-only port while T3 remained on its existing
paths. The generated J5 test state was moved intact to `/tmp/j5code-t3-verify.ZuaG9H` after shutdown.
