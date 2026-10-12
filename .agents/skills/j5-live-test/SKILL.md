---
name: j5-live-test
description: Live-test a J5 Code change on a real server with real agents. Use when unit tests cannot prove the change, such as UI flows, agent turns, agent-to-agent messages, Crews, Playbooks, peering, first run, or PR screenshots. Covers asking for a test and running one. Sets up a safe test server with one script, then hands the browser steps to test-t3-app.
---

# Live-test J5 Code

Two roles use this skill. If you built the change, read "Ask for a test". If
you were asked to test, read "Run a test". Both need "What to cover".

## Ask for a test

Commit first. Spawn a Peer Agent (`j5_spawn_agent`) in its own worktree,
started from that commit, and keep working while it tests. Tell it:

- the commit, and what changed;
- what to test;
- which rows of "What to cover" apply;
- to follow this skill.

Its report comes back as a short message naming an artifact. Put the verdict,
what was not exercised live, and what the person must test by hand in the PR's
"Live testing" section.

## Run a test

### Set up

From your worktree, run:

```bash
node scripts/j5/setup-agent-live-test.ts
```

Follow what it prints. It builds a test home and a small test repository under
your worktree's ignored `.j5code/live-test`, starts the server, and prints the ports, the
pairing URL, the project to use, and the stop command. Nothing in that home
points at a real repository or at the developer's data.

| If you need                                     | Add             |
| ----------------------------------------------- | --------------- |
| An empty home, so the first-run wizard shows    | `--fresh`       |
| Two peered servers, named Local and Remote      | `--peer`        |
| The same, with Remote polling Local             | `--peer --poll` |
| A base and a head server for before/after shots | `--base <ref>`  |

The script builds one setup per worktree. To change mode, run `rebuild` with
the new flags. A `--fresh` home has no project and no pinned model: add only
the test repository the script names, and pick your model by hand. Open it in
a tab with `profileId: "incognito"`: the default browser profile may have
finished onboarding already, and then the wizard does not show.

`stop`, `status`, and `restart` act on the server the script started. `status`
starts with `RUNNING`, `NOT SERVING`, or `STOPPED`, and prints a fresh pairing
URL when the server is up. Run `stop` when you finish.
`rebuild` stops it, discards the test home, and builds and starts a new one.
The script does not install dependencies: if it says they are missing, install
them and run it again.

After a `rebuild`, a tab that was open before it can stay on the pairing form.
Press "Reload app" there.

The test home, test repository, and logs live under `.j5code/live-test`. Live
turns also leave provider session files in `~/.claude` and `~/.codex`, and
Browser panel screenshots are saved by the server you are running in.

Do not seed a test home by hand, copy the live database, or start `vp run dev`
yourself for a test. Then use [test-t3-app](../test-t3-app/SKILL.md) for the
browser steps.

### Live turns

- Send live turns only in new threads in the test project. The threads the
  script made are for looking at.
- Use only the models the person has authorized for live test turns. The test
  home defaults new threads to Claude Haiku, a cheap one.
- Take live turns in "Current checkout" mode. In a Crew roster that choice is
  "Captain's checkout". A first turn in "New worktree" mode can be interrupted
  or hang.
- After editing a Crew roster, check each seat's model again before approving:
  an edit can change it.
- A test agent on Claude can still reach real Claude sessions on this machine
  through its own harness tools (`ListAgents`, `SendMessage`). When a test has
  agents message each other, tell the test agent to use J5's tools and the
  participants `j5_list_participants` returns, and check which tool it called.
- An agent's own account of what it did is not evidence. Check the tool
  result, the stored row, or the screen.
- To hold a turn open, ask the agent to run `./scripts/hold.sh` in the test
  repository. It blocks until you create `.hold-release` in the test
  repository's root, deletes that file, and exits. It gives up after nine
  minutes.

### Restarts

Restart only at rest, or during a held turn. Do not try to catch the server in
a narrow window, such as mid-migration. A bug that needs one gets a
deterministic test.

### Report

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

## PR screenshots

Use `--base <ref>` so base and head show the same data. Open the second server
in a tab with `profileId: "incognito"`, so the two do not share a login.
Capture at 1280x800 as test-t3-app describes, then upload with
`scripts/j5/pr-evidence.sh`, which prints the before/after table for the PR
description.

## A server for the developer

`--for-dev` starts a server on a copy of the developer's data and shares it
with them. It is only for sharing with the developer: do not test on it, take
no turns on it, and never publish a screenshot from it. Its threads belong to
real checkouts and real provider sessions.

## What this cannot test

Say so in the report instead of implying coverage:

- the desktop app: Electron, the packaged build, the updater, installers;
- relay and tunnel connections, a second machine, an unreachable peer;
- continuing one of the threads the script made;
- behavior under the developer's real data volume;
- providers other than Codex and Claude on this host.
