// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Runs one sample on the real Claude Code, through the SDK J5's adapter uses and with the options
 * J5 sends. A case's earlier turns become a session file in Claude Code's own format, which the
 * sample resumes; the case's prompt is the live turn.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  makeClaudeQueryOptions,
  makeClaudeUserMessage,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { normalizeToolInput, normalizeToolName, type SampleRun } from "../mcp-tool-use/run.ts";
import { CLAUDE_BINARY, type HookCallback, query, type SDKUserMessage } from "./sdk.ts";
import { fileContents, printCommand, SIM_DIR, simulate } from "./shell.ts";
import { heldCommand, steerFor, whenExists } from "./steer.ts";
import { addClaudeResult, emptyUsage, type Usage } from "./usage.ts";
import { type Sample, splitConversation, UNSUPPORTED_EMPTY_PROMPT } from "./upstream.ts";

/**
 * Where the session file holds the steer: Claude Code's queued_command attachment and, on CLIs
 * that record API requests, the request message that carried it to the model.
 */
const steerTranscript = (cwd: string, sessionId: string | undefined, steer: string) => {
  if (sessionId === undefined) return [];
  const file = NodePath.join(
    NodeOS.homedir(),
    ".claude/projects",
    cwd.replaceAll("/", "-"),
    `${sessionId}.jsonl`,
  );
  if (!NodeFS.existsSync(file)) return [];
  const marker = JSON.stringify(steer.split("\n")[0]).slice(1, -1);
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "attachment" || entry.type === "api-request-blob")
    .map(({ type, message, attachment }) => ({ type, message, attachment }));
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Writes the case's earlier turns as a Claude Code session and returns its id. */
const writeSession = (
  sample: Sample,
  messages: ReturnType<typeof splitConversation>["history"],
  options: { readonly cwd: string; readonly model: string; readonly version: string },
) => {
  const { cwd, model, version } = options;
  const sessionId = NodeCrypto.randomUUID();
  let parentUuid: string | null = null;
  const lines: Array<string> = [];
  for (const [index, message] of messages.entries()) {
    const { content } = message;
    const uuid = NodeCrypto.randomUUID();
    const common = {
      parentUuid,
      isSidechain: false,
      type: message.role,
      uuid,
      timestamp: new Date(Date.now() - (messages.length - index) * 1000).toISOString(),
      userType: "external",
      entrypoint: "sdk-cli",
      cwd,
      sessionId,
      version,
      gitBranch: sample.testCase.setup.world?.branch ?? "main",
    };
    lines.push(
      JSON.stringify(
        message.role === "assistant"
          ? {
              ...common,
              message: {
                model,
                id: `msg_eval_${index}`,
                type: "message",
                role: "assistant",
                content,
                stop_reason: content.some((block) => block.type === "tool_use")
                  ? "tool_use"
                  : "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }
          : { ...common, message: { role: "user", content } },
      ),
    );
    parentUuid = uuid;
  }
  if (lines.length === 0) return undefined;
  const dir = NodePath.join(NodeOS.homedir(), ".claude/projects", cwd.replaceAll("/", "-"));
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  return sessionId;
};

/**
 * Answers shell and file calls from the simulator by rewriting them before they run. `hold` may
 * wrap a Bash command so it keeps running while a steer is delivered.
 */
const simulatingHook =
  (
    sample: Sample,
    hold?: (original: string, command: string) => string | undefined,
  ): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !isRecord(input.tool_input)) return {};
    const tool = input.tool_name;
    const toolInput = { ...input.tool_input };
    if (tool !== "Bash" && tool !== "Read") return {};
    const { output, file } = await simulate(sample, tool, toolInput);
    const printed = tool === "Bash" ? printCommand(output, file) : "";
    const updatedInput =
      tool === "Bash"
        ? { ...toolInput, command: hold?.(String(toolInput.command), printed) ?? printed }
        : { ...toolInput, file_path: fileContents(output, file) };
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    };
  };

/** Streaming input, as J5's adapter feeds Claude Code: messages can be pushed mid-turn. */
const makeInput = () => {
  const pending: Array<SDKUserMessage> = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push: (message: SDKUserMessage) => {
      pending.push(message);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    async *messages() {
      while (true) {
        const next = pending.shift();
        if (next !== undefined) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
};

// Claude Code reports a uuid-stamped queued message with a command_lifecycle frame. If none
// arrives in this long, the hold is released anyway and the row shows no lifecycle.
const STEER_QUEUE_TIMEOUT_MS = 15_000;

export const runClaude = async (
  sample: Sample,
  options: {
    readonly model: string;
    readonly effort: string;
    readonly cwd: string;
    readonly mcpUrl: string;
    readonly maxTurns: number;
    readonly signal: AbortSignal;
  },
): Promise<SampleRun & { readonly usage: Usage }> => {
  const { testCase } = sample;
  const usage = emptyUsage();
  const version =
    /^[\d.]+/.exec(
      (await import("node:child_process")).execFileSync(CLAUDE_BINARY, ["--version"], {
        encoding: "utf8",
      }),
    )?.[0] ?? "unknown";
  const { history, prompt } = splitConversation(sample);
  if (prompt === undefined) throw new Error(UNSUPPORTED_EMPTY_PROMPT);
  const resumeId = writeSession(sample, history, { ...options, version });
  const j5Options = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: options.model,
      options: [{ id: "effort", value: options.effort }],
    },
    nativeThreadId: resumeId ?? NodeCrypto.randomUUID(),
    resume: resumeId !== undefined,
    cwd: options.cwd,
    mcpServers: { "t3-code": { type: "http", url: options.mcpUrl } },
    deviceToolsAvailable: testCase.setup.world?.deviceAgentAccess !== false,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  const steer = steerFor(testCase);
  const input = makeInput();
  const steerUuid = NodeCrypto.randomUUID();
  const lifecycle: Array<string> = [];
  let queued: () => void = () => {};
  const steerQueued = new Promise<void>((resolve) => (queued = resolve));
  let held = false;
  const holdFiles = {
    started: NodePath.join(SIM_DIR, `${steerUuid}.started`),
    release: NodePath.join(SIM_DIR, `${steerUuid}.release`),
  };
  // Once the held command is running, push the steer, wait until Claude Code queues it, release.
  const deliver = async () => {
    await whenExists(holdFiles.started);
    input.push(makeClaudeUserMessage({ text: steer!.message, priority: "next", uuid: steerUuid }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      steerQueued,
      new Promise((resolve) => (timer = setTimeout(resolve, STEER_QUEUE_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    NodeFS.writeFileSync(holdFiles.release, "");
  };
  const hold =
    steer === undefined
      ? undefined
      : (original: string, command: string) => {
          if (held || !new RegExp(steer.during).test(original)) return undefined;
          held = true;
          void deliver();
          return heldCommand(command, holdFiles);
        };
  const hooks = {
    ...j5Options.hooks,
    PreToolUse: [...(j5Options.hooks?.PreToolUse ?? []), { hooks: [simulatingHook(sample, hold)] }],
  };
  if (steer !== undefined)
    input.push(makeClaudeUserMessage({ text: prompt, uuid: NodeCrypto.randomUUID() }));
  const run: SampleRun & { calls: Array<SampleRun["calls"][number]> } = {
    calls: [],
    text: "",
    stopReason: "unknown",
  };
  const abortController = new AbortController();
  options.signal.addEventListener("abort", () => abortController.abort(options.signal.reason));
  const steps = new Map<string, number>();
  let finalText: string | undefined;
  let sessionId: string | undefined;
  let results = 0;
  try {
    for await (const message of query({
      prompt: steer === undefined ? prompt : input.messages(),
      options: {
        ...j5Options,
        hooks,
        maxTurns: options.maxTurns,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        abortController,
      },
    })) {
      sessionId ??= message.session_id;
      const frame = message as { type: string; command_uuid?: unknown; state?: unknown };
      if (frame.type === "command_lifecycle" && frame.command_uuid === steerUuid) {
        lifecycle.push(String(frame.state));
        queued();
      }
      if (message.type === "assistant") {
        const id = message.message.id;
        if (!steps.has(id)) steps.set(id, steps.size);
        const step = steps.get(id)!;
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            run.calls.push({
              step,
              id: block.id,
              tool: normalizeToolName(block.name),
              input: normalizeToolInput(block.name, block.input),
            });
          } else if (block.type === "text") {
            run.text += `${block.text}\n`;
          }
        }
      } else if (message.type === "user" && Array.isArray(message.message.content)) {
        // Device grading reads what each call returned and whether the agent saw an error.
        for (const block of message.message.content) {
          if (block.type !== "tool_result") continue;
          const call = run.calls.find((entry) => entry.id === block.tool_use_id);
          if (call === undefined) continue;
          call.failed = block.is_error === true;
          call.output =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? [])
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n");
        }
      } else if (message.type === "result") {
        // The streaming input stays open for a steer; the sample ends with the turn.
        results += 1;
        input.close();
        addClaudeResult(usage, message);
        run.stopReason = message.subtype === "success" ? "end_turn" : message.subtype;
        if (message.subtype === "success") finalText = message.result;
      }
    }
  } catch (cause) {
    // Running out of turns ends the sample, as upstream's step limit does; it is graded.
    if (run.stopReason !== "error_max_turns") throw cause;
  } finally {
    input.close();
  }
  if (steer !== undefined && !held) {
    throw new Error("The agent never ran the held command, so no steer was sent.");
  }
  return {
    ...run,
    ...(steer === undefined
      ? {}
      : {
          steer: {
            lifecycle,
            results,
            transcript: steerTranscript(options.cwd, sessionId, steer.message),
          },
        }),
    ...(finalText === undefined ? {} : { finalText }),
    linked: [...sample.linked],
    ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
    usage,
  };
};
