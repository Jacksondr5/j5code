---
title: "Merging upstream"
kind: process
---

# Merging upstream

How J5 advances to a new upstream T3 Code. FORK.md holds the rules this depends on: the integration-case inventory, temporary patches, the pin log and the rewrite runbook. This page is the checklist that stops an advance from missing something. The agents doing it are capable; use judgment, not ceremony.

## Shape

- **One PR.** The advance and every fork adaptation it forces land together, however large.
- **Freeze.** Record the fork head, the previous pin and the upstream SHA. Upstream's V2 branch is force-rewritten often, so don't chase it mid-merge.
- **Use the previous pin as the content base.** Git's own merge base is usually wrong after a rewrite: run `git merge-tree --write-tree --merge-base=<pin> <upstream> <fork>` and resolve the result on a branch started at the upstream SHA, so the candidate descends from upstream. Then make a two-parent merge of the fork head and the candidate (`git commit-tree <candidate>^{tree} -p <fork> -p <candidate>`). The merge tree must equal the candidate tree (FORK.md rewrite runbook).

## Review before building

- **Real content delta:** diff the pin against the candidate; the commit log misleads after rewrites. Summarize what upstream added, especially anything touching J5 areas.
- **Literal conflicts** at the pin base, then the **breaks that merge cleanly**, which cause most defects:
  - **J5-owned code** that imports or calls upstream APIs that changed (typecheck an approximate merge).
  - **New upstream files** that carry branding or `~/.t3` / `T3CODE_HOME` paths. BRANDING.md only lists files we already know.
  - **New ways to create or archive a thread**, which must carry a Squadron and run the archive preflight.
  - **Upstream behavior** that crosses a J5 policy, such as resume, Stop, queues or delivery.
  - **Migrations:** run `node scripts/j5/check-upstream-migrations.ts --base <pin> --candidate <candidate>`. A renumbering or insertion needs a bridge arm, a reviewed manifest, the checker's `--allow-reviewed-bridge`, and a rehearsal on a `VACUUM INTO` copy of real data.
  - **Codex replay fixtures:** take upstream's transcripts and rerun `scripts/j5/migrate-codex-fixtures.mjs` over them; never hand-merge them.
  - **New upstream workflows** that need the `pingdotgg/t3code` repository guard.
- **Walk every FORK.md integration case and temporary patch.** For each patch, decide keep, retire (upstream fixed it) or narrow.
- **Rewrite** the [upstream convergence watchlist](../research/upstream-convergence.md) and check the give-back backlog (#276).
- **Bring the decisions to the maintainer.** Default to adopting upstream and adjusting later if it proves bad.

## Build and verify

- Typecheck every package, including the root `scripts` project, to zero errors. Run the full suites for server, web, client-runtime, shared, contracts, mobile and desktop.
- Rehearse migrations through the production startup path (`layerConfig`), including the `statev2.sqlite` copy. Check a second boot and J5 table integrity.
- **Never touch the live install.** Run service tests with `HOME` and `XDG_CONFIG_HOME` pointed at a temp directory, and check that the live units' hashes are unchanged afterwards. `~/.j5code/userdata` is read-only.
- Update FORK.md (cases, patches, pin log), BRANDING.md, the user migration guide if install or data changes, and this watchlist.

## After merge

- Cut the release and migrate machines per the user guide.
- File the follow-up issues the review agreed on.
