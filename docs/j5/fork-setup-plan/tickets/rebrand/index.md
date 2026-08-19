---
title: "T3 — Rebrand to J5 Code (minimal-churn)"
kind: ticket
status: 2
---

# T3 — Rebrand to J5 Code

**Goal:** the app identifies as **J5 Code** everywhere a user or OS sees it, and can never collide with Jackson's installed T3 Code — while touching the minimum upstream surface.

## Scope

- Enumerate every identity site (research counted ~6 bundle-ID sites; verify by grepping current pin): desktop bundle ID / app ID, product name in packaging config, mobile app IDs (present but dormant — rename anyway, cheap), deep-link / URL schemes, update-feed identifiers.
- Rename: bundle ID → `codes.jackson.j5code` (mobile variants suffixed), display name → **J5 Code**.
- **State isolation (load-bearing):** find where the app derives its config/state directories (state.sqlite location, app-support dirs) and confirm the renamed app resolves to its own paths — J5 Code running beside installed T3 Code must share nothing. Verify empirically: launch both, check dirs.
- Do **NOT** rename `T3CODE_*` env vars, internal package names, or in-code strings — upstream-churn surface. Keep a `BRANDING.md` (or section in FORK.md) listing every renamed site so rebases re-verify them.
- Confirm absent-cloud-config posture: no `.env` → no relay/Clerk/telemetry endpoints referenced (per `scripts/lib/public-config.ts` graceful degradation).

## Out of scope

Icons/visual identity (later, with product vision). Mass internal renames. Update feed implementation.

## Dependencies

**T2** (need a building app to verify). Blocks T5.

## Acceptance

Branded J5 Code build launches beside installed T3 Code with disjoint state dirs and separate OS identity (dock/taskbar, app support paths); rename inventory recorded; full build still green.

## Result — 2026-08-15

Completed on `j5/main` from the reviewed upstream pin `993407dd9`.

### Delivered

- Added the fork-owned identity source `scripts/lib/j5-branding.ts` and durable rebase inventory
  `BRANDING.md`.
- Desktop production identity is `J5 Code` / `codes.jackson.j5code`; development uses
  `J5 Code (Dev)` and a checkout-suffixed `codes.jackson.j5code.dev.*` bundle ID.
- Default desktop state moved from `~/.t3` to `~/.j5code`; Application Support, Linux identity,
  deep-link schemes, server renderer origins, artifact names, and DMG copy are J5-specific.
- Mobile production/dev/preview names, bundle/package IDs, schemes, links, and package scripts are
  J5-specific. Expo OTA updates are disabled pending J5-owned infrastructure.
- Web fallback title/branding is J5-specific.
- Preserved all `T3CODE_*` variables, internal package names, database/storage keys, and general
  upstream code copy.

### Acceptance evidence

- Installed T3 Code (Alpha) and J5 Code (Dev) ran concurrently.
- T3: `com.t3tools.t3code`, `~/.t3/userdata`, Application Support `t3code` /
  `T3 Code (Alpha)`, schemes `t3code*`.
- J5: `codes.jackson.j5code.dev.j5code`, `~/.j5code/dev/state.sqlite`, Application Support
  `j5code-dev`, schemes `j5code*`. J5 logged `~/.j5code/dev/logs` and used dedicated test ports
  `17773` / `15733`.
- Both apps and test servers shut down cleanly. The newly-created J5 verification state was moved
  intact to `/tmp/j5code-t3-verify.ZuaG9H`; Jackson's T3 state was not altered except by launching
  the installed app for the requested coexistence check.
- Scrubbed-environment Expo manifest: `J5 Code`, `j5-code`, `j5code`,
  `codes.jackson.j5code` on iOS and Android, OTA disabled, zero configured relay/Clerk/telemetry
  endpoint values, no hard-coded EAS project ID or owner.
- `vp run -r --log grouped typecheck`: 15/15 tasks passed (pre-existing Effect suggestions only).
- Focused identity/state/packaging/link tests: 11 files, 129 tests passed.
- `pnpm build`: 5/5 build tasks passed. Existing large-chunk, optional `bun:sqlite`, dynamic-import,
  plugin-timing, and sourcemap warnings matched the T2 baseline class.
- `vp fmt --check`: passed. `vp lint --report-unused-disable-directives`: passed with only 29
  pre-existing repository warnings and no errors.
- Lockfile remained unchanged after verification.
