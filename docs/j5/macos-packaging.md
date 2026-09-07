# Build and install J5 Code for macOS

J5 Code's personal-use build is ad-hoc signed. It has a valid local code signature but no Apple
Developer ID certificate or notarization ticket, so macOS may require a one-time manual approval.
The build contains no configured update feed unless you explicitly provide one.

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

- `J5 CI` runs formatting, lint, typecheck, and unit-test gates on every `j5/**` push and PR.
- `J5 Weekly Full Build` runs Mondays at 08:23 UTC and on manual dispatch. It runs the full suite,
  full build, produces the ad-hoc signed Apple Silicon DMG/ZIP, verifies the mounted app, and uploads
  the artifacts for 30 days.
