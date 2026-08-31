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

## Rebase audit sites

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

- All `T3CODE_*` environment variables, including the explicit `T3CODE_HOME` override.
- Internal workspace/package names such as `@t3tools/*`, `t3`, and upstream lint rule names.
- Database schema names, persisted mobile storage keys, internal CLI flags, and code identifiers.
- General upstream product copy and documentation outside the identity sites above.

## Cloud and update posture

- Desktop publishing is configured only when `T3CODE_DESKTOP_UPDATE_REPOSITORY` or
  `GITHUB_REPOSITORY` is supplied; the fork does not hard-code an upstream update repository.
- Mobile Expo updates are disabled until Jackson configures J5-owned update infrastructure.
- The mobile manifest contains no hard-coded Expo project, owner, Apple team, Clerk domain, relay,
  or telemetry endpoint. Optional values continue to use the upstream `T3CODE_*` / `EXPO_PUBLIC_*`
  configuration names.

## 2026-08-15 empirical isolation check

Installed T3 Code (Alpha) and J5 Code (Dev) ran concurrently on macOS:

| App             | Bundle ID                         | Runtime state    | App Support                  |
| --------------- | --------------------------------- | ---------------- | ---------------------------- |
| T3 Code (Alpha) | `com.t3tools.t3code`              | `~/.t3/userdata` | `t3code` / `T3 Code (Alpha)` |
| J5 Code (Dev)   | `codes.jackson.j5code.dev.j5code` | `~/.j5code/dev`  | `j5code-dev`                 |

The J5 backend logged `~/.j5code/dev/logs`, created `~/.j5code/dev/state.sqlite`, registered the
`j5code-dev` renderer scheme, and listened on its test-only port while T3 remained on its existing
paths. The generated J5 test state was moved intact to `/tmp/j5code-t3-verify.ZuaG9H` after shutdown.
