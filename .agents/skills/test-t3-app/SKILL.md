---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. Its browser runs on the
server, so it works without a desktop app connected. If its tools are absent,
or `preview_open` itself fails, explain the blocker and stop verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

In J5 Code, set the server up with [j5-live-test](../j5-live-test/SKILL.md):
it starts an isolated server and prints the ports and pairing URL used below.

Otherwise reuse this task's healthy dev server, or run
`env -u T3CODE_PORT -u T3CODE_HOST -u J5CODE_HOME vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.j5code` state and read the actual ports and pairing URL from the dev-runner
output. Never run against `~/.j5code/userdata` or set `VITE_HTTP_URL` or
`VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

Tools that act on the panel need the calling thread's turn to be live. Drive
it from the primary agent, from a subagent its parent waits for, or from a
Peer Agent. "The calling provider no longer owns an active thread run" means
the parent's turn ended; it is not a browser fault.

- **Open.** `preview_status` showing `available: false` with a `profiles`
  list means no tab yet. Call `preview_open` with `reuseExistingTab: false`,
  and pass the returned `tabId` on every later call.
- **Pair.** Navigate to the complete startup pairing URL once with
  `preview_navigate`, then `preview_wait_for` the locator
  `[data-testid="composer-editor"]`: navigate returns while the splash screen
  still shows. If the token was consumed or expired, run
  `node apps/server/src/bin.ts pair --base-dir <worktree>/.j5code` for a fresh
  one. Keep using the same tab.
- **Move.** Navigate with `target: {kind: "environment-port", port, path}`.
  The URL changes before the page does, so wait for text that only the new
  page has.
- **Read.** Use `preview_evaluate`, for example
  `document.querySelector('main')?.innerText`. `preview_snapshot` text is
  capped, and the sidebar uses the cap up.
- **Act.** Use role locators or test ids, such as
  `role=button[name="Submit message"]`.
- **Recover.** After a timeout, or "No preview automation host is available",
  call `preview_status`. Once it lists `profiles` again, retry once: the
  browser reconnects within a second.
- **Capture.** `preview_resize` to 1280x800, then `preview_snapshot` with
  `save: true`. The file is written to the server's own data directory, so
  copy it out. Open a second tab with `profileId: "incognito"` for a second
  server.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
