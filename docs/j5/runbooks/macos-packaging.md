---
title: "Build and install J5 Code for macOS"
kind: runbook
---

# Build and install J5 Code for macOS

The local personal-use build below is ad-hoc signed. It has a valid local code signature but no Apple
Developer ID certificate or notarization ticket, so macOS may require a one-time manual approval.
Local builds omit the update feed unless `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`
is configured. GitHub Actions builds use the J5 repository.

## Prerequisites

- Apple Silicon Mac with Xcode Command Line Tools.
- `fnm`, Node from `.nvmrc`, and pnpm `11.10.0`.
- `rustup`; entering the repository selects Rust `1.95.0` from `rust-toolchain.toml` without
  changing the machine's default toolchain.
- A clean J5 checkout on the reviewed `j5/main` pin.

## Build

```sh
fnm install
fnm use
pnpm install --frozen-lockfile
pnpm dist:desktop:dmg:arm64 --adhoc-sign --output-dir release-j5
```

The output is `release-j5/J5-Code-<version>-arm64.dmg` plus the matching ZIP. No certificate,
Apple account, or signing secret is required.

Do not insert a standalone `--` before the build flags. With pnpm `11.10.0`, that separator is
forwarded to this script as a positional argument instead of being removed.

## Verify

Set `dmg_path` to the exact DMG produced by the build, replacing `<version>`, then mount it
read-only at a temporary path and check its identity and signature:

```sh
dmg_path="release-j5/J5-Code-<version>-arm64.dmg"
mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/j5-dmg.XXXXXX")"
hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -readonly
app_path="$mount_dir/J5 Code.app"
plutil -extract CFBundleDisplayName raw "$app_path/Contents/Info.plist"
plutil -extract CFBundleIdentifier raw "$app_path/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign -dv --verbose=4 "$app_path" 2>&1 | grep -F 'Signature=adhoc'
hdiutil detach "$mount_dir"
rmdir "$mount_dir"
```

The expected display name is `J5 Code`, the bundle ID is `codes.jackson.j5code`, and the signature
line is `Signature=adhoc`. These checks inspect the package; they do not launch the application
or verify its interactive behavior.

## Install and first launch

1. Open the verified DMG in Finder and drag **J5 Code** to `/Applications`.
2. In Finder, Control-click **J5 Code**, choose **Open**, then confirm **Open**. This records a
   one-time local Gatekeeper approval for the unnotarized build.
3. If macOS still blocks it, open **System Settings → Privacy & Security**, find the J5 Code notice,
   choose **Open Anyway**, and authenticate when prompted.

Do not disable Gatekeeper globally and do not remove quarantine recursively from `/Applications`.
J5 Code uses `~/.j5code` and J5-specific Application Support paths, so it can remain installed beside
T3 Code.

## GitHub Actions

For a public release:

1. Bump the release versions with `node scripts/update-release-package-versions.ts <version>`. It
   writes the same version into `apps/server`, `apps/desktop`, `apps/web`, and `packages/contracts`
   `package.json`. Commit the change and push it as `j5/release-<version>`.
2. Run `J5 Signed macOS Build` on that branch. Keep the branch at the same commit until publication:
   GitHub restricts release creation with the standard Actions token when the target commit is no
   longer a branch head or tag.
3. After CI and the signed build pass, run `J5 Release` with that build's numeric run ID.
4. After publication, bring the version bump into `j5/main` with a PR so `j5/main` never reports an
   older version than the latest release.

`J5 Release` publishes one GitHub Release, tagged `v<version>` at the build's commit, containing:

- the signed and notarized Apple Silicon DMG and ZIP, their blockmaps, and `latest-mac.yml` from the
  selected build run;
- self-contained CLI archives `t3-<version>-darwin-arm64.tar.gz` (Developer ID signed and notarized)
  and `t3-<version>-linux-x64.tar.gz`, built and smoke-tested in the release run from the same
  commit;
- `install.sh` and `SHA256SUMS` over the archives and the installer.

Its resolve job reads the version from the build commit's four manifests, which must agree on one
stable version of at least 0.0.44 (0.0.43 and earlier were npm releases). If a release for that
version already exists at a different commit, the run fails: bump the version and build again. If
it is already published from the same commit with `SHA256SUMS` attached, the run does nothing. The
workflow uses GitHub-hosted runners and does not deploy relay or Vercel services.

The install one-liner (`https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh`),
`j5 update`, the background service, and desktop SSH remote launch all download from these releases.
J5 no longer publishes to npm. The CLI executable is `j5`; its workspace name remains `t3` to preserve
upstream task references and Effect service identifiers, and the archive's program keeps the name
`t3`.

`J5 Signed macOS Build` builds an Apple Silicon DMG and ZIP on a GitHub-hosted macOS runner,
signs with Developer ID, and notarizes the app. It verifies the mounted app's identity, signature,
notarization ticket, and Gatekeeper assessment before uploading artifacts for 30 days. It does not
create a GitHub Release. The workflow uses the Apple signing secrets and
`APPLE_TEAM_ID` repository variable; it converts the P12 export to a Keychain-compatible format.
Clerk passkey provisioning is only required when Clerk/passkey configuration is supplied.

- `J5 CI` runs formatting, lint, typecheck, and unit-test gates on every `j5/**` push and PR.
- `J5 Weekly Full Build` runs Mondays at 08:23 UTC and on manual dispatch. It runs the full suite,
  full build, produces the ad-hoc signed Apple Silicon DMG/ZIP, verifies the mounted app, and uploads
  the artifacts for 30 days.
