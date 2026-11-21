// @effect-diagnostics nodeBuiltinImport:off globalDate:off
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

import { makeClaudeQueryOptions } from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { normalizeToolInput, normalizeToolName, type SampleRun } from "../mcp-tool-use/run.ts";
import { CLAUDE_BINARY, type HookCallback, query } from "./sdk.ts";
import { fileContents, printCommand, simulate } from "./shell.ts";
import { addClaudeResult, emptyUsage, type Usage } from "./usage.ts";
import { type Sample, splitConversation, UNSUPPORTED_EMPTY_PROMPT } from "./upstream.ts";

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

/** Answers shell and file calls from the simulator by rewriting them before they run. */
const simulatingHook =
  (sample: Sample): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !isRecord(input.tool_input)) return {};
    const tool = input.tool_name;
    const toolInput = { ...input.tool_input };
    if (tool !== "Bash" && tool !== "Read") return {};
    const { output, file } = await simulate(sample, tool, toolInput);
    const updatedInput =
      tool === "Bash"
        ? { ...toolInput, command: printCommand(output, file) }
        : { ...toolInput, file_path: fileContents(output, file) };
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    };
  };

export const runClaude = async (
  sample: Sample,
  options: {
    readonly model: string;
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
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: options.model },
    nativeThreadId: resumeId ?? NodeCrypto.randomUUID(),
    resume: resumeId !== undefined,
    cwd: options.cwd,
    mcpServers: { "t3-code": { type: "http", url: options.mcpUrl } },
    deviceToolsAvailable: testCase.setup.world?.deviceAgentAccess !== false,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  const hooks = {
    ...j5Options.hooks,
    PreToolUse: [...(j5Options.hooks?.PreToolUse ?? []), { hooks: [simulatingHook(sample)] }],
  };
  const run: SampleRun & { calls: Array<SampleRun["calls"][number]> } = {
    calls: [],
    text: "",
    stopReason: "unknown",
  };
  const abortController = new AbortController();
  options.signal.addEventListener("abort", () => abortController.abort(options.signal.reason));
  const steps = new Map<string, number>();
  let finalText: string | undefined;
  try {
    for await (const message of query({
      prompt,
      options: {
        ...j5Options,
        hooks,
        maxTurns: options.maxTurns,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        abortController,
      },
    })) {
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
        addClaudeResult(usage, message);
        run.stopReason = message.subtype === "success" ? "end_turn" : message.subtype;
        if (message.subtype === "success") finalText = message.result;
      }
    }
  } catch (cause) {
    // Running out of turns ends the sample, as upstream's step limit does; it is graded.
    if (run.stopReason !== "error_max_turns") throw cause;
  }
  return {
    ...run,
    ...(finalText === undefined ? {} : { finalText }),
    linked: [...sample.linked],
    ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
    usage,
  };
};
