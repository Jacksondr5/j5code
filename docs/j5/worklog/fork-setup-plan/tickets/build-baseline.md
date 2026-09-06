---
title: "T2 — Build up & test baseline"
kind: ticket
status: 2
---

# T2 — Build up & test baseline

**Goal:** the pinned tip builds and runs on Jackson's machine, and we have a recorded test baseline to diff every future rebase against.

## Tooling permission (from Jackson, 2026-08-15)

You have standing permission to install software this ticket needs — bun, playwright, macOS build tools, Xcode/CLT, etc. **Prefer Homebrew** wherever possible so Jackson can keep everything updated centrally. Anything you cannot resolve yourself (licenses, App Store logins, OS-level prompts, disk space), escalate to the Director agent rather than working around it.

**Upstream protocol correction 2026-08-15:** after the reviewed pin advance to `993407dd9`, the repository declares `packageManager: pnpm@11.10.0`, Node `^24.13.1`, `pnpm-lock.yaml`, and 15 pnpm `patchedDependencies`. The stale Bun install instruction below described the original pre-advance pin. For this baseline, use fnm with the repo's `.nvmrc` and `pnpm install --frozen-lockfile`; do not alter Jackson's machine-wide Node default. Vite Plus is provided by the pinned repo-local dev dependency and initialized by pnpm's prepare script; no separate account, license, or global installation is required.

## Scope

- Fresh clone of `Jacksondr5/j5code` (`j5/main`); under fnm-selected Node from `.nvmrc`, run `pnpm install --frozen-lockfile` — **verify all 15 pnpm patches apply cleanly**; any patch failure is a stop-and-report, not a workaround.
- Build server, web, and desktop targets per the repo's own scripts/turbo pipeline (consult upstream AGENTS.md/CONTRIBUTING.md; prefer the repo's documented dev flow).
- Launch the app locally in an **isolated dev environment** — use the repo's `test-t3-app` skill conventions (worktree-safe state directories, pairing flow) so Jackson's real installed T3 Code state is never touched. Drive one agent turn end-to-end with whichever provider CLI is installed (Claude Code and/or Codex).
- Run the full test suite once (branch has ~913 tests). Record results in a sub-artifact `../baseline.md`: pass/fail counts per package, every failure classified as `upstream-known` (fails on pristine pin) — this is by definition, since we've changed nothing.
- Note dev-machine prerequisites discovered along the way (bun version, native deps) in the same artifact.

## Out of scope

Fixing upstream test failures (record only). Renaming (T3). Packaging (T5).

## Dependencies

**T1.** Blocks T3, T6.

## Acceptance

Dev app launches from the fork in an isolated state dir; one agent turn completes; `../baseline.md` exists with full suite results + prerequisites.

## Result — 2026-08-15

- Installed and used the advanced pin's declared pnpm/Vite Plus protocol. Frozen install passed the 2,032-entry supply-chain policy check, materialized all 15 declared patch hashes, completed native postinstalls, and left the lockfile clean.
- Added `.nvmrc` (`24.14.0`) for fnm and CI; committed the toolchain record as `9aa49b7e4`. Repo-local Vite Plus required no account, license, auth, or global install.
- Passed the full repository build and the explicit desktop pipeline build under Node 24.
- Launched the dev stack with explicit base `/Users/jackson/repos/jacksondr5/j5code/.t3/t2-baseline`, completed a real paired-browser Codex turn, verified the completed run and exact response in that isolated SQLite database, stopped the tracked process, and confirmed its ports closed. No source file was changed by the agent turn.
- Full suite passed: 14/14 tasks; 929 test files passed plus 4 skipped; 8,598 tests passed plus 10 skipped; zero failures.
- Recorded package-level counts, prerequisites, commands, warnings, build evidence, and state-isolation evidence in `../baseline.md`.
- Surprises handled: the upstream pin migrated from Bun to pnpm/Node 24/Vite Plus; an early superseded direction installed Homebrew `node@24`, but it is keg-only/unlinked and did not alter Jackson's default Node. The reproducible J5 path is fnm plus `.nvmrc`.
