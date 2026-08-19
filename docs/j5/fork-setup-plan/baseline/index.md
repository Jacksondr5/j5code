---
title: "J5 Code build and test baseline"
kind: spec
---

# J5 Code build and test baseline

Recorded 2026-08-15 on macOS 26.6.1 arm64 from `/Users/jackson/repos/jacksondr5/j5code`.

## Source

| Item                                   | Value                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| Upstream pin                           | `993407dd9e57f1edf2f5681d70140bfefeca93cc`                  |
| Checked-out branch                     | `j5/main`                                                   |
| J5 HEAD during baseline                | `09d4b61c94dc7bc6a19e5bb81e3ffc8f55a59874` (`FORK.md` only) |
| Runtime source changes before baseline | None                                                        |

## Prerequisites and install

| Tool               | Baseline version / decision                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Node               | `24.14.0`, selected with existing `fnm 1.39.0` from new `.nvmrc`                              |
| pnpm               | `11.10.0`, matching `packageManager`                                                          |
| Vite Plus          | Repo-local `vite-plus 0.2.2`; no global install, account, license, or authentication required |
| Rust               | `rustc 1.94.0`, `cargo 1.94.0` (present; not needed by the JavaScript suite)                  |
| Browser automation | Playwright CLI wrapper using the repository dev server's one-time pairing URL                 |

Install command:

```sh
fnm exec --using=24.14.0 pnpm install --frozen-lockfile
```

Result: success in 47.1 seconds; 1,914 packages installed; pnpm's 2,032-entry supply-chain policy check passed; native Electron, `node-pty`, Sharp, esbuild, and msgpackr postinstalls completed. The prepare hook patched and verified the Effect TypeScript language-service binary and ran the repo-local Vite Plus configuration.

Patch verification: `pnpm-workspace.yaml` and `pnpm-lock.yaml` declare exactly 15 `patchedDependencies`; all 15 corresponding patch hashes were materialized under `node_modules/.pnpm`; the frozen install reported no patch failure; git state retained no lockfile or dependency-file changes.

The original setup plan expected Bun. The reviewed upstream advance migrated contributor setup to pnpm, Node 24, and repo-local Vite Plus. A superseded instruction caused Homebrew `node@24` 24.19.0 to be installed first; it remains keg-only and unlinked, did not replace Jackson's default Node, and is not part of the J5 protocol. The reproducible path is fnm plus `.nvmrc`.

## Builds

| Command                                       | Result | Coverage                                               |
| --------------------------------------------- | ------ | ------------------------------------------------------ |
| `fnm exec --using=24.14.0 pnpm build`         | Pass   | Full repository build: web, marketing, server, desktop |
| `fnm exec --using=24.14.0 pnpm build:desktop` | Pass   | Web → server bundle → Electron main/preload pipeline   |

Observed non-fatal upstream warnings: web chunks over 500 kB; Vite/Rolldown plugin timing hints; sourcemap warnings from declaration-generation transforms; the Cursor SDK's optional `bun:sqlite` import was externalized under Node; one Effect Node HTTP module is both statically and dynamically imported. No build task failed.

## Isolated dev and real agent turn

The dev stack was launched with an explicit state base, not an ambient or installed-app directory:

```sh
fnm exec --using=24.14.0 pnpm exec vp run dev \
  --home-dir /Users/jackson/repos/jacksondr5/j5code/.t3/t2-baseline
```

The runner reported:

- server `127.0.0.1:13773`, web `localhost:5733`
- `baseDir=/Users/jackson/repos/jacksondr5/j5code/.t3/t2-baseline`
- state database `.t3/t2-baseline/userdata/state.sqlite`
- a fresh run of migrations 1–49

The isolated database was seeded only with a local project record for the J5 checkout. The browser paired through the one-time URL and completed one real Codex turn using `GPT-5.6-Sol`, low reasoning, full-access runtime. Prompt: `Reply with exactly: J5 baseline turn complete. Do not run commands or modify files.` Response: `J5 baseline turn complete.`

Post-run database evidence:

- thread title `J5 Baseline Turn`, default provider `codex`
- run ordinal 1 has status `completed` and a non-null completion timestamp
- user and assistant messages are stored with `streaming = 0`

The browser snapshot directory created by the automation tool was moved outside the checkout after evidence capture. Final source status showed only the intended `.nvmrc` and `FORK.md` documentation changes; the agent ran no command and changed no source file. The dev stack was stopped through its tracked session with Ctrl-C, and neither port remained listening.

## Full test suite

Command:

```sh
fnm exec --using=24.14.0 pnpm exec vp run -r --log grouped --verbose test
```

Overall: **14/14 workspace tasks passed; 929 test files passed, 4 skipped; 8,598 tests passed, 10 skipped; 0 failures.** With no failures, there are no `upstream-known` failure classifications to carry forward.

| Workspace                       | Test files            | Tests                    | Result |
| ------------------------------- | --------------------- | ------------------------ | ------ |
| `effect-codex-app-server`       | 5 passed              | 22 passed                | Pass   |
| `@t3tools/contracts`            | 24 passed             | 286 passed               | Pass   |
| `effect-acp`                    | 5 passed              | 37 passed                | Pass   |
| `@t3tools/shared`               | 46 passed             | 385 passed               | Pass   |
| `@t3tools/tailscale`            | 1 passed              | 13 passed                | Pass   |
| `@t3tools/oxlint-plugin-t3code` | 4 passed              | 35 passed                | Pass   |
| `@t3tools/ssh`                  | 4 passed              | 26 passed                | Pass   |
| `@t3tools/scripts`              | 18 passed             | 232 passed               | Pass   |
| `@t3tools/client-runtime`       | 57 passed             | 674 passed               | Pass   |
| `@t3tools/desktop`              | 61 passed             | 553 passed               | Pass   |
| `@t3tools/mobile`               | 117 passed            | 740 passed               | Pass   |
| `t3code-relay`                  | 27 passed             | 209 passed               | Pass   |
| `@t3tools/web`                  | 269 passed            | 2,589 passed             | Pass   |
| `t3` server                     | 291 passed, 4 skipped | 2,797 passed, 10 skipped | Pass   |

The server package runs files serially by upstream configuration and completed in 409.21 seconds. Its only repeated runtime output was Node's experimental SQLite warning. The scripts package also emitted Node's `fs.F_OK` deprecation warning. Neither affected results.
