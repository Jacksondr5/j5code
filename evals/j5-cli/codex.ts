// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Runs one sample on the real Codex through `codex app-server`, the protocol J5's adapter speaks,
 * with the thread config and turn parameters J5 builds. A case's earlier turns are appended with
 * `thread/inject_items`; the case's prompt is the live turn. Shell calls go through the image's
 * managed PreToolUse hook (codex-hook.mjs), which asks the runner for simulated output.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildCodexTurnStartParams,
  CODEX_THREAD_CONFIG,
} from "../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { toMcpElicitationResponse } from "../../apps/server/src/provider/CodexMcpElicitation.ts";
import type { SampleRun } from "../mcp-tool-use/run.ts";
import { printCommand, simulate } from "./shell.ts";
import { emptyUsage, type Usage } from "./usage.ts";
import {
  codexMessages,
  type Sample,
  splitConversation,
  UNSUPPORTED_EMPTY_PROMPT,
} from "./upstream.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A small JSON-RPC client for app-server's newline-delimited stdio protocol. */
const startAppServer = (env: NodeJS.ProcessEnv) => {
  const child = NodeChildProcess.spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const stderr: Array<string> = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (message.method !== undefined && message.id !== undefined) {
      // A request from Codex, such as an approval. Full access asks for none; refuse anything else.
      if (process.env.EVAL_DEBUG) console.error(`[codex] request ${message.method}`);
      // Full access: J5's Codex adapter accepts MCP elicitations (tool-call approvals) itself.
      if (message.method === "mcpServer/elicitation/request") {
        const result = toMcpElicitationResponse(message.params as never, "accept");
        child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
        return;
      }
      child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Not supported in the eval." } })}\n`,
      );
    } else if (message.method !== undefined) {
      for (const listener of listeners) listener(message.method, message.params ?? {});
    } else if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`${message.error.message}`));
      else waiter?.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`codex app-server exited ${code}: ${stderr.join("").slice(-2000)}`));
    }
  });
  return {
    request: (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
    notify: (method: string, params: unknown) =>
      child.stdin.write(`${JSON.stringify({ method, params })}\n`),
    onNotification: (listener: (method: string, params: Record<string, unknown>) => void) =>
      listeners.push(listener),
    close: () => child.kill(),
  };
};

/** The case's earlier turns as Codex items, without Claude Code's ToolSearch steps. */
const priorItems = (history: ReturnType<typeof splitConversation>["history"]) =>
  codexMessages(
    history
      .map((message) => ({
        role: message.role,
        content: message.content.filter(
          (block) =>
            !(block.type === "text" && block.text === "Tool loaded.") &&
            !(block.type === "tool_use" && block.name === "ToolSearch") &&
            !(
              block.type === "tool_result" &&
              Array.isArray(block.content) &&
              block.content.some((part) => isRecord(part) && part.type === "tool_reference")
            ),
        ),
      }))
      .filter((message) => message.content.length > 0),
  );

export const runCodex = async (
  sample: Sample,
  options: {
    readonly model: string;
    readonly cwd: string;
    readonly mcpUrl: string;
    readonly hookUrl: string;
    readonly maxTurns: number;
    readonly effort: string;
    readonly setHook: (
      hook: (input: Readonly<Record<string, unknown>>) => Promise<unknown>,
    ) => void;
    readonly signal: AbortSignal;
  },
): Promise<SampleRun & { readonly usage: Usage }> => {
  const { testCase } = sample;
  const usage = emptyUsage();
  const run: SampleRun & { calls: Array<SampleRun["calls"][number]> } = {
    calls: [],
    text: "",
    stopReason: "unknown",
  };
  let hookError: unknown;
  options.setHook(async (input) => {
    const toolInput = isRecord(input.tool_input) ? { ...input.tool_input } : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
    if (input.tool_name !== "Bash" || command === undefined) return {};
    const call: SampleRun["calls"][number] = {
      step: run.calls.length,
      tool: "Bash",
      input: { command },
    };
    run.calls.push(call);
    const simulated = await simulate(sample, "Bash", { command }).catch((cause: unknown) => {
      hookError ??= cause;
      return undefined;
    });
    // Nothing runs for real when the simulator fails; the sample then reports the failure.
    if (simulated === undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "The eval's shell simulator failed.",
        },
      };
    }
    const { output, file } = simulated;
    call.output = output;
    call.failed = /^Exit code [1-9]/.test(output);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, command: printCommand(output, file) },
      },
    };
  });
  const server = startAppServer({ ...process.env, EVAL_HOOK_URL: options.hookUrl });
  try {
    await server.request("initialize", {
      clientInfo: { name: "j5-eval", title: null, version: "0" },
      capabilities: { experimentalApi: true },
    });
    server.notify("initialized", {});
    const started = (await server.request("thread/start", {
      model: options.model,
      cwd: options.cwd,
      config: {
        ...CODEX_THREAD_CONFIG,
        "mcp_servers.t3-code": { url: options.mcpUrl, tool_timeout_sec: 3900 },
      },
    })) as { thread: { id: string } };
    const threadId = started.thread.id;
    const { history, prompt } = splitConversation(sample);
    if (prompt === undefined) throw new Error(UNSUPPORTED_EMPTY_PROMPT);
    const items = priorItems(history);
    if (items.length > 0) await server.request("thread/inject_items", { threadId, items });
    const turnParams = await Effect.runPromise(
      buildCodexTurnStartParams({
        nativeThreadId: threadId,
        codexInput: [{ type: "text", text: prompt, text_elements: [] }],
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: options.cwd },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: options.model,
          options: [{ id: "reasoningEffort", value: options.effort }],
        },
        hasT3Mcp: true,
        browserToolsAvailable: true,
        deviceToolsAvailable: testCase.setup.world?.deviceAgentAccess !== false,
      }),
    );
    const messages: Array<string> = [];
    const mcpCalls = new Map<string, SampleRun["calls"][number]>();
    const done = new Promise<void>((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
      server.onNotification((method, params) => {
        const item = isRecord(params.item) ? params.item : undefined;
        if (process.env.EVAL_DEBUG) console.error(`[codex] ${method} ${String(item?.type ?? "")}`);
        if (method === "item/started" && item?.type === "mcpToolCall") {
          const call = {
            step: run.calls.length,
            tool: String(item.tool),
            input: item.arguments ?? {},
          };
          run.calls.push(call);
          mcpCalls.set(String(item.id), call);
          if (run.calls.length > options.maxTurns * 2) {
            void server
              .request("turn/interrupt", { threadId, turnId: params.turnId })
              .catch(() => {});
          }
        } else if (method === "item/started" && item?.type === "collabAgentToolCall") {
          run.calls.push({ step: run.calls.length, tool: "Agent", input: item });
        } else if (method === "item/started" && item?.type === "webSearch") {
          run.calls.push({
            step: run.calls.length,
            tool: "WebSearch",
            input: { query: item.query },
          });
        } else if (method === "item/started" && item?.type === "fileChange") {
          run.calls.push({
            step: run.calls.length,
            tool: "Edit",
            input: { changes: item.changes },
          });
        } else if (method === "item/completed" && item?.type === "mcpToolCall") {
          // Device grading reads what each call returned and whether the agent saw an error.
          const call = mcpCalls.get(String(item.id));
          const result = isRecord(item.result) ? item.result : {};
          const content = Array.isArray(result.content) ? result.content : [];
          if (call !== undefined) {
            call.failed = item.error != null || result.isError === true;
            call.output = isRecord(item.error)
              ? String(item.error.message)
              : content
                  .flatMap((part) =>
                    isRecord(part) && typeof part.text === "string" ? [part.text] : [],
                  )
                  .join("\n");
          }
        } else if (method === "item/completed" && item?.type === "agentMessage") {
          messages.push(String(item.text ?? ""));
        } else if (method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage)) {
          const total = isRecord(params.tokenUsage.total) ? params.tokenUsage.total : {};
          usage.inputTokens = Number(total.inputTokens ?? 0) - Number(total.cachedInputTokens ?? 0);
          usage.cachedInputTokens = Number(total.cachedInputTokens ?? 0);
          usage.outputTokens = Number(total.outputTokens ?? 0);
        } else if (method === "turn/completed") {
          const turn = isRecord(params.turn) ? params.turn : {};
          run.stopReason = turn.status === "completed" ? "end_turn" : String(turn.status);
          resolve();
        }
      });
    });
    await server.request("turn/start", turnParams);
    await done;
    if (hookError !== undefined) throw hookError;
    run.text = messages.join("\n");
    return {
      ...run,
      ...(messages.length > 0 ? { finalText: messages.at(-1)! } : {}),
      linked: [...sample.linked],
      ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
      usage,
    };
  } finally {
    server.close();
  }
};
