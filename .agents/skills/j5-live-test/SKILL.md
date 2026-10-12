---
name: j5-live-test
description: Live-test a J5 Code change on a real server with real agents. Use when unit tests cannot prove the change, such as UI flows, agent turns, agent-to-agent messages, Crews, Playbooks, peering, first run, or PR screenshots. Sets up a safe test server with one script, then hands the browser steps to test-t3-app.
---

# Live-test J5 Code

## Set up

From your worktree, run:

```bash
node scripts/j5/setup-agent-live-test.ts
```

Follow what it prints. It builds a test home and a small test repository inside
your worktree's ignored `.j5code`, starts the server, and prints the ports, the
pairing URL, the project to use, and the stop command. Nothing in that home
points at a real repository or at the developer's data.

| You need                                                 | Add             |
| -------------------------------------------------------- | --------------- |
| An empty home, so the first-run wizard shows             | `--fresh`       |
| Two peered servers, named Local and Remote               | `--peer`        |
| The same, with Remote polling Local                      | `--peer --poll` |
| A base and a head server for before/after shots          | `--base <ref>`  |
| A server the developer will use, on a copy of their data | `--for-dev`     |

`stop`, `status`, and `restart` act on the server the script started.

Do not seed a test home by hand, copy the live database, or start `vp run dev`
yourself for a test. Then use [test-t3-app](../test-t3-app/SKILL.md) for the
browser steps.

## Who tests

The tester is a Peer Agent (`j5_spawn_agent`) in its own worktree, so the agent
that asked for the test can keep working. Commit first, and start the tester's
worktree from that commit. A subagent that outlives its parent's turn cannot
use the Browser panel.

Tell the tester the commit, what changed, what to test, and which rows of
"What to cover" apply.

## Live turns

- Send live turns only in new threads in the test project. The threads the
  script made are for looking at.
- Claude Haiku and GPT Luna need no permission. The test home defaults new
  threads to Haiku. Ask the person before using a more expensive model.
- An agent's own account of what it did is not evidence. Check the tool
  result, the stored row, or the screen.
- To hold a turn open, ask the agent to run `./scripts/hold.sh` in the test
  repository. It blocks until you create the file it names.

On a `--for-dev` server, take no turns. Its threads belong to real checkouts
and real provider sessions.

## What to cover

Always: the change's own flow, including the way back out, and one real turn
sent through the UI.

| When the change touches                          | Also run                                                 |
| ------------------------------------------------ | -------------------------------------------------------- |
| The turn path, provider adapters, or MCP tools   | One turn each on Codex and Claude                        |
| Stored state, deliveries, or recovery            | `restart` at rest, then use the state                    |
| Interrupted runs                                 | `restart` during a held turn                             |
| Migrations                                       | A migration rehearsal on a copy, and a `--fresh` run     |
| Startup, onboarding, or settings defaults        | A `--fresh` run                                          |
| Anything an agent is meant to use                | Ask a real agent in plain words, without naming the tool |
| Peering or cross-server messages                 | A `--peer` run                                           |
| UI, after a rebase or review fix that touched it | The browser pass again, before merge                     |

Restart only at rest, or during a held turn. Do not try to catch the server in
a narrow window, such as mid-migration. A bug that needs one gets a
deterministic test.

## Report

Save the report with `j5_write_artifact` at `test-reports/<branch>.md`, then
send whoever asked for the test a short message with the verdict and that path.

1. Verdict: pass, fail, or blocked, with the commit and the script flags.
2. Not exercised live: each gap, why, and whether it needs the person.
3. For the person to test by hand: exact steps. Leave out when empty.
4. What ran: each row of "What to cover" as run, or not applicable with a
   reason. Say how each was verified: live, by test, or from code.
5. Bugs found, each with steps to reproduce.
6. Rig problems: anything in the test setup that got in the way.

A claim without one of those three labels counts as not verified.

## PR screenshots

Use `--base <ref>` so base and head show the same data. Capture at 1280x800 as
test-t3-app describes, then upload with `scripts/j5/pr-evidence.sh`, which
prints the before/after table for the PR description. Never publish a
screenshot from a `--for-dev` server.

## What this cannot test

Say so in the report instead of implying coverage:

- the desktop app: Electron, the packaged build, the updater, installers;
- relay and tunnel connections, a second machine, an unreachable peer;
- continuing one of the threads the script made;
- behavior under the developer's real data volume;
- providers other than Codex and Claude on this host.
