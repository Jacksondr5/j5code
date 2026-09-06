---
title: "T5 — Light CI & desktop packaging"
kind: ticket
status: 2
---

# T5 — Light CI & desktop packaging

**Goal:** every push to our branches gets automatic quality gates, and Jackson can install J5 Code as a real desktop app (not just a development server).

**Toolchain decision 2026-08-15:** workflows must follow the advanced pin's declared protocol: Node from `.nvmrc` via `actions/setup-node`'s `node-version-file`, pnpm `11.10.0`, the committed `pnpm-lock.yaml`, and pnpm caching. Vite Plus comes from the repo-local dependency installed by pnpm. Do not reintroduce the original pin's Bun install path.

## Scope

- **CI** (GitHub Actions on the public fork): on push/PR to `j5/*` branches — fmt → lint → typecheck → unit tests, reusing the repo's existing turbo tasks; keep runtime reasonable by scoping unit tests with turbo's affected-package filtering if the full suite is slow in CI. A second, scheduled (weekly) + manually-triggerable workflow runs the full suite + full desktop build — this is the pre-rebase check.
- **Packaging:** produce an installable macOS desktop build of J5 Code from the repo's packaging scripts — unsigned/ad-hoc signing is fine (personal use; document the Gatekeeper bypass). Keep update-feed config unset/pluggable — no update infrastructure now.
- Write the runbook (build + package + install steps) into FORK.md or a `docs/j5/` note.

## Out of scope

Code signing certificates, notarization, auto-update, mobile builds, release automation.

## Dependencies

**T3** (package the branded app, not T3-branded). Blocks nothing hard; T6 can run in parallel.

## Acceptance

CI green on a test PR; weekly workflow runs on demand; Jackson installs and launches J5 Code from a packaged artifact on his Mac.

## Result — 2026-08-15

Complete on `j5/main` at `b660064645125fb700744acc6bc2dc302d83250f`.

- Added the lightweight push/PR gate in `.github/workflows/j5-ci.yml`: frozen pnpm install, format, lint, typecheck, and unit tests under Node from `.nvmrc`.
- Added the Monday/manual full-build gate in `.github/workflows/j5-weekly.yml`: pinned Rust, full suite, full build, ad-hoc-signed Apple Silicon DMG, mounted-bundle identity/signature verification, and artifact upload.
- Added `rust-toolchain.toml` at Rust 1.95.0. The committed `Cargo.lock` resolves `sysinfo` 0.39.3, whose genuine MSRV is 1.95; the package/build path already uses `--locked`. Jackson's global Rust default remains 1.94.0.
- Added `docs/j5/macos-packaging.md`, an explicit `--adhoc-sign` packaging option, fork-only workflow guards, and ignored `release-j5/` output.
- Local package: `J5-Code-0.0.33-arm64.dmg`, SHA-256 `fbbce3e49cfaa9b31c990d698ce81b8498b48d519b3a0c4606e162d09e67dc09`. The mounted app verified `J5 Code`, `codes.jackson.j5code`, `arm64`, and `Signature=adhoc`.
- Installed `/Applications/J5 Code.app`; it launched to backend-ready/main-window-created and quit cleanly. Empirical state writes remained under J5 paths (`~/.j5code` and `~/Library/Application Support/j5code`).

### Hosted evidence

- [PR #1](https://github.com/Jacksondr5/j5code/pull/1) delivered the CI/package implementation at `43f28c9a3`; its J5 push and PR gates passed.
- [PR #2](https://github.com/Jacksondr5/j5code/pull/2) advanced `pnpm/action-setup` from v4 to v6 for Node 24 compatibility at exact head/merge `b6600646`.
- [PR #2 J5 CI run 31904838472](https://github.com/Jacksondr5/j5code/actions/runs/31904838472) passed in 12m36s; the parallel push gate also passed.
- [Manual weekly run 31904849383](https://github.com/Jacksondr5/j5code/actions/runs/31904849383) passed in 12m58s on exact SHA `b6600646`. It uploaded `j5-code-macos-arm64` (323,048,523 bytes) after verifying display name, bundle ID, deep/strict code signature, and `Signature=adhoc` on the mounted DMG.

### Notes and surprises

- The original `pnpm/action-setup@v4` live run emitted GitHub's Node 20 action-runtime deprecation warning. The v6 follow-up ran cleanly on both Ubuntu and macOS Node 24 runners.
- Checkout post-cleanup emits a non-fatal warning because upstream contains nested vendored Git metadata at `.repos/alchemy-effect/.vendor/alchemy` without a matching root `.gitmodules` URL. All jobs still conclude successfully; no upstream vendoring change was made.
- Lint reports 29 pre-existing warnings but exits successfully. No new warning was introduced by the J5 files.
