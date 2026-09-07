# J5 Code branding boundary

J5 Code keeps upstream's internal names stable and owns only the identifiers that people,
operating systems, installers, and deep-link dispatchers use. Recheck this inventory after every
upstream pin advance.

## Canonical identity

Fork-owned values live in `scripts/lib/j5-branding.ts`:

| Surface                     | Production             | Development / preview                                   |
| --------------------------- | ---------------------- | ------------------------------------------------------- |
| Display name                | `J5 Code`              | `J5 Code (Dev)`, `J5 Code (Nightly)`, `J5 Code Preview` |
| Desktop / mobile app ID     | `codes.jackson.j5code` | `.dev` and `.preview` suffixes                          |
| URL scheme                  | `j5code`               | `j5code-dev`, `j5code-preview`                          |
| Default desktop state       | `~/.j5code/userdata`   | `~/.j5code/dev`                                         |
| Default server state        | `~/.j5code/userdata`   | `~/.j5code/dev`                                         |
| Desktop App Support         | `j5code`               | `j5code-dev`                                            |
| Linux executable / WM class | `j5code`               | `j5code-dev`                                            |
| Desktop artifact prefix     | `J5-Code-`             | same                                                    |

The macOS development launcher adds a checkout-derived suffix to the development bundle ID so
multiple J5 checkouts can coexist. Production remains exactly `codes.jackson.j5code`.

## Pin-advance audit sites

- Home resolution: `apps/server/src/cli/config.ts`, `app.ts`, `pair.ts`, `theme.ts`, `triage.ts`,
  `cloud/bootService.ts`, `serviceLauncher.ts`, `packages/shared/src/devHome.ts`, and
  `scripts/dev-runner.ts`. Explicit CLI home outranks worktree isolation; worktree dev
  state outranks an ambient home. Pairing must target the same resolved state.
- SSH runner homes: `packages/ssh/src/tunnel.ts` keeps upstream npm runners on `~/.t3`
  and J5 node-script runners on `~/.j5code`.
- Desktop runtime identity and state: `DesktopEnvironment.ts`, `DesktopStatePaths.ts`,
  `DesktopEarlyElectronStartup.ts`, and `DesktopAppIdentity.ts`.
- Desktop OS integration: `electron-launcher.mjs`, `ElectronProtocol.ts`,
  `DesktopLinuxUrlHandler.ts`, and the server renderer-origin allowlist in `apps/server/src/http.ts`.
- Desktop packaging: `apps/desktop/package.json`, `scripts/build-desktop-artifact.ts`, and both DMG
  background SVGs.
- Mobile OS identity and links: `apps/mobile/app.config.ts`, mobile package scripts, `App.tsx`,
  pairing QR handling, and the Agent Activity widget.
- Web fallback identity: `apps/web/src/branding.ts` and the pre-React boot shell in
  `apps/web/index.html`.

## Deliberately unchanged upstream internals

- The `T3CODE_*` environment variables other than the base-directory override, which is `J5CODE_HOME`. An ambient `T3CODE_HOME` is ignored, and a linked worktree's dev state lives in `<worktree>/.j5code`, so J5 never shares state with an installed T3 Code (FORK.md case 25).
- Internal workspace/package names such as `@t3tools/*`, `t3`, and upstream lint rule names.
- Database schema names, persisted mobile storage keys, internal CLI flags, and code identifiers.
- General upstream product copy and documentation outside the identity sites above.

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
