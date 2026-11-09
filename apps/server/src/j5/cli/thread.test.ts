import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ThreadTools } from "../../cli/thread.ts";
import { sendToThread, spawnArgs, startAgent } from "./thread.ts";

const threadId = ThreadId.make("thread:j5:cli");
const runId = RunId.make("run:j5:cli");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

const noFlags = {
  title: Option.none(),
  persona: Option.none(),
  provider: Option.none(),
  model: Option.none(),
  reasoning: Option.none(),
  runtimeMode: Option.none(),
  worktree: Option.none(),
  branch: Option.none(),
};

it.effect("start asks for a model choice and maps its flags onto j5_spawn_agent", () =>
  Effect.gen(function* () {
    // j5_spawn_agent takes no default model, so nothing is guessed for the person.
    const unchosen = yield* Effect.flip(spawnArgs(noFlags, "Fix the build"));
    assert.include(unchosen.message, "--persona, or --provider and --model");
    const half = yield* Effect.flip(
      spawnArgs({ ...noFlags, provider: Option.some("codex") }, "Fix the build"),
    );
    assert.include(half.message, "--provider and --model go together");

    assert.deepStrictEqual(
      yield* spawnArgs({ ...noFlags, persona: Option.some("reviewer") }, "Fix the build"),
      {
        title: "Fix the build",
        brief: "Fix the build",
        // The project's own checkout, as upstream's start runs in the project folder.
        workspace: { type: "root" },
        persona: "reviewer",
      },
    );
    assert.deepStrictEqual(
      yield* spawnArgs(
        {
          ...noFlags,
          provider: Option.some("claudeAgent"),
          model: Option.some("claude-haiku-5-5"),
          reasoning: Option.some("low"),
          runtimeMode: Option.some("approval-required"),
          worktree: Option.some("main"),
          branch: Option.some("fix/build"),
        },
        "Fix the build",
      ),
      {
        title: "Fix the build",
        brief: "Fix the build",
        workspace: { type: "worktree", base_ref: "main", branch: "fix/build" },
        provider: "claudeAgent",
        model: "claude-haiku-5-5",
        reasoning: "low",
        runtime_mode: "approval-required",
      },
    );
  }),
);

it.effect("start --wait follows the run the agent's brief started", () =>
  Effect.gen(function* () {
    const { tools, calls } = scriptedTools({
      j5_spawn_agent: [
        { participant_id: "agent:j5:a2a:thread:j5:cli", thread_id: threadId, project_id: "p" },
      ],
      t3_thread_read: [
        { recentRuns: [{ runId }] },
        { thread: { pendingRequestCount: 0 }, items: [], hasMore: false, nextPosition: null },
      ],
      t3_thread_wait: [{ threadId, runId, status: "completed", timedOut: false }],
    });
    const args = { title: "Fix", brief: "Fix", workspace: { type: "root" }, persona: "builder" };

    yield* startAgent(tools, { projectId: "project:cli", args, wait: true, json: true });

    assert.deepStrictEqual(calls[0], {
      tool: "j5_spawn_agent",
      args: { project_id: "project:cli", ...args },
    });
    assert.deepStrictEqual(calls.find((entry) => entry.tool === "t3_thread_wait")?.args, {
      threadId,
      runId,
      timeoutMs: 15_000,
    });
  }),
);

it.effect("send reaches the thread's agent through j5_send_message, never upstream's send", () =>
  Effect.gen(function* () {
    const { tools, calls } = scriptedTools({
      j5_send_message: [
        {
          messageId: "message:j5:cli",
          exchangeId: null,
          exchangeState: "none",
          joinedExistingExchange: false,
          durableAtSeq: 1,
        },
      ],
    });

    yield* sendToThread(tools, { threadId, message: "Status?", json: true });

    assert.deepStrictEqual(calls, [
      {
        tool: "j5_send_message",
        args: { to: "agent:j5:a2a:thread:j5:cli", message: "Status?" },
      },
    ]);
  }),
);
