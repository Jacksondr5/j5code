# MCP tool use on the real CLIs

Runs [mcp-tool-use](../mcp-tool-use/) cases on the real Claude Code and Codex, in a container, on your Claude and ChatGPT subscriptions. It needs no API key and no CLIProxyAPI.

Each sample uses the case's fake world and upstream's grader. The difference from upstream's runner is the harness: the model sees the real CLI's prompt and tools, at the versions pinned in the `Dockerfile`, with the options J5 sends.

## Set up once

1. Have Docker. `node evals/j5-cli/launch.ts build` builds the pinned image.
2. Claude: run `claude setup-token` and save the token in a file outside the repo, readable only by you. Pass its path as `CLAUDE_TOKEN_FILE` on every run.
3. Codex: `node evals/j5-cli/launch.ts login-codex`, then enter the code it prints. The login stays in the `j5-eval-codex-home` Docker volume. It is a separate login from your own. Never copy your `~/.codex/auth.json` into it: a copy can sign out the original when one of them refreshes.

## Run

```sh
CLAUDE_TOKEN_FILE=<file> node evals/j5-cli/launch.ts run -- \
  --case review-round-uses-thread-send --harness claude --model claude-sonnet-5-5 --out evals/runs/check
```

- **Choosing what runs:**
  - `--case <id>` (repeatable; default: every case for the harness), `--harness claude|codex`, `--model`, `--effort`.
  - `--catalog j5|upstream`: the T3 tools listed. The default `j5` lists what J5's server lists, with J5's own tools. `upstream` lists upstream's set, for comparing with upstream's runner.
- **Samples:** `--samples <n>`. Without it, each case runs 2 samples, and a 3rd when the first 2 disagree, as upstream does.
- **Comparing:** `--baseline <results.jsonl>` adds the earlier pass rates. With `--stop-on-regression`, cases that passed every baseline sample run first, and the run stops at the first one that fails.
- **Parallel:** `--shards <n>` splits the cases across n containers that run at once. Each has its own checkout and Claude home. The Codex login is shared, as it would be on one machine. The results are merged into `<out>`. Every sample still uses your subscriptions, so n multiplies how fast the run uses up their limits.
- **Limits:** `--max-turns` (default 8, or the case's `maxSteps`) and `--timeout-minutes` per sample (default 10).
- **Checking a case:** `node evals/j5-cli/run.ts --dry-run --case <id>` prints the conversation the harness would get, on the host, without a container.
- **Output:** `<out>/results.jsonl`, one row per sample, written as each sample finishes. `<out>/summary.md` has pass rates by case and by kind, and the tokens the agent and the shell simulator used. For Claude it adds the API-price figure Claude Code reports. That measures load, not spend: the run is billed to the subscription.
- Every Codex run needs `CLAUDE_TOKEN_FILE` too, because the shell simulator runs on Claude Haiku.
- `launch.ts logs` shows each host the egress proxy allowed or refused. `launch.ts down` removes the proxy and network.

## How it works

- **Container:** one per run, with an empty home folder and the checkout mounted read-only at its own path. Its network reaches only the model providers' hosts, through `egress-proxy.ts`.
- **T3 tools:** `mcp.ts` serves the real tool schemas from source and answers from the case's mocks. Each tool's own visibility rule decides whether it's listed for the case's thread. Device tools answer from upstream's fake device hosts. J5's own tools answer from `j5Results.ts` when the case doesn't mock them.
- **J5's cases:** `cases/` holds J5's own cases. One whose `source.replaces` names an upstream case runs in its place on the J5 catalog, because the upstream case checks tools J5 replaced (`t3_thread_launch`, `create_threads`, `t3_thread_send`).
- **Turns J5's server writes:** a Crew seat's first delivery, another agent's message, and a Captain's launch report are rendered by the server's own functions (`j5Turns.ts`). A case names each under `j5Turns` and places it with `{{j5:<name>}}` in its prompt or an earlier turn's text, giving only the facts: brief, roster, message bodies.
- **Accounts:** Codex's ChatGPT apps and plugins are off in `codex-requirements.toml`. They reach the account's connectors through `chatgpt.com`, which the allowlist must admit, and a connector can lead to a live server. Claude Code with a `setup-token` loads no claude.ai connectors.
- **Earlier turns:**
  - Claude: written as a Claude Code session file, then resumed.
  - Codex: added with app-server's `thread/inject_items`.
- **Shell:** a PreToolUse hook rewrites each shell command so it prints the simulator's output instead of running.
  - Claude: the hook is an SDK callback.
  - Codex: the hook is managed policy (`codex-requirements.toml`), because `app-server` ignores `--dangerously-bypass-hook-trust`.
  - Anything a hook misses runs inside the container, and the network allowlist blocks it from going out.

## Limits

- **Session format:** the forged Claude session file uses Claude Code's undocumented format. After bumping the pinned version, re-run a case with earlier turns.
- **Real file edits:** Claude's Edit and Write, and Codex's `apply_patch`, run for real on the throwaway checkout.
- **Unsupported cases:** two kinds are reported as unsupported, not graded:
  - cases that resume a thread without a new user message, which neither CLI can do;
  - the cases in `DATE_DEPENDENT`, whose worlds assume upstream's template date. The CLIs read today's date, and it can't be faked: Claude Code hangs under libfaketime, and Codex is statically linked.
- **J5 tools** other than the ones `j5Results.ts` covers answer `{"ok": true}` without a mock.
- **Comparing results:** compare only with runs of this runner, not with upstream's numbers.
- **Cost:** runs use your subscriptions' limits, the same ones your live agents use.
