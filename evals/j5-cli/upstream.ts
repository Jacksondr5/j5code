// @effect-diagnostics nodeBuiltinImport:off
/**
 * The parts of upstream's mcp-tool-use eval this runner shares: cases, sample state, T3 tool
 * schemas, T3 tool results and grading.
 *
 * Mirror: `withProductFields`, `SUBAGENT_WATCH_ERROR`, `codexCall` and `codexMessages` copy
 * evals/mcp-tool-use/run.ts, which does not export them. Replace them with imports once it does.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { EnvironmentId, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT, ThreadId } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import {
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import { J5AttachmentUploadToolkit } from "../../apps/server/src/j5/a2a/mcp/attachments.ts";
import { J5OrchestratorSurface } from "../../apps/server/src/j5/a2a/mcp/orchestratorSurface.ts";
import { J5AdaptedThreadToolkit } from "../../apps/server/src/j5/a2a/mcp/threadTools.ts";
import { J5Toolkit } from "../../apps/server/src/j5/a2a/mcp/tools.ts";
import {
  J5ArtifactToolkit,
  J5EnvironmentToolkit,
  J5OrchestratorToolkit,
  J5ProjectToolkit,
  J5ThreadToolkit,
} from "../../apps/server/src/j5/a2a/mcp/upstreamCatalog.ts";
import {
  buildBase,
  buildMessages,
  makeSample,
  McpToolUseCase,
  t3Default,
} from "../mcp-tool-use/run.ts";
import { deviceFailure, isDeviceTool } from "../mcp-tool-use/devices.ts";
import { j5Default } from "./j5Results.ts";
import { withJ5Turns } from "./j5Turns.ts";

export type Sample = ReturnType<typeof makeSample>;
type BaseModel = Parameters<typeof buildBase>[1]["model"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const upstreamDir = NodePath.join(import.meta.dirname, "../mcp-tool-use");
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));

const readCases = (dir: string) =>
  NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".ndjson"))
    .flatMap((name) =>
      NodeFS.readFileSync(NodePath.join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => withJ5Turns(decodeCase(line), JSON.parse(line))),
    );

/**
 * Upstream's cases, plus J5's on the J5 catalog. A J5 case that names `source.replaces` takes the
 * place of that upstream case, whose tools J5 does not offer.
 */
export const loadCases = (ids: ReadonlyArray<string>, catalog: Catalog) => {
  const j5 = catalog === "j5" ? readCases(NodePath.join(import.meta.dirname, "cases")) : [];
  const replaced = new Set(
    j5.flatMap(({ source }) => (typeof source?.replaces === "string" ? [source.replaces] : [])),
  );
  const all = [
    ...readCases(NodePath.join(upstreamDir, "cases")).filter(({ id }) => !replaced.has(id)),
    ...j5,
  ];
  return ids.length === 0 ? all : all.filter((testCase) => ids.includes(testCase.id));
};

/**
 * Upstream's sample state, built on its Claude template. Only the state is used here (the fake
 * world, linked PRs, task numbers); the real harness supplies its own prompt and tools.
 */
export const sampleFor = (testCase: McpToolUseCase, model: string, catalog: Catalog) => {
  const template = JSON.parse(
    NodeZlib.gunzipSync(
      NodeFS.readFileSync(NodePath.join(upstreamDir, "templates/claude.json.gz")),
    ).toString("utf8"),
  ).request.provider_native;
  const { role } = testCase.setup;
  const base = buildBase(template, {
    model: "claude-sonnet-5-5",
    keepUserInstructions: false,
    subagent: role === "delegated-child",
    nativeSubagent: role === "native-subagent",
    links: testCase.setup.linkedEnvironments === true,
    deviceAccess: testCase.setup.world?.deviceAgentAccess !== false,
  });
  // Upstream's list lacks J5's tools; earlier turns that call one load it from the catalog.
  const missing = t3McpTools(testCase, catalog)
    .map((tool) => ({
      name: `mcp__t3-code__${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
    .filter((tool) => !base.deferred.some(({ name }) => name === tool.name));
  return makeSample(testCase, {
    ...base,
    deferred: [...base.deferred, ...missing],
    model: model as BaseModel,
  });
};

/** Neither CLI can resume a turn without a new user message, which these cases need. */
export const UNSUPPORTED_EMPTY_PROMPT = "Unsupported: the case resumes without a user message.";

/**
 * The real CLIs read today's date, and these cases' worlds assume upstream's template date. Claude
 * Code hangs under libfaketime and Codex is statically linked, so the date can't be faked.
 */
export const DATE_DEPENDENT = new Set([
  "schedule-one-time-date",
  "schedule-one-off-tomorrow",
  "guard-x-card-png-uses-shot",
]);
export const UNSUPPORTED_DATE = "Unsupported: the case depends on upstream's template date.";

type Message = ReturnType<typeof buildMessages>[number];
const textOf = (block: Message["content"][number]) =>
  block.type === "text" && typeof block.text === "string" ? block.text : undefined;

/**
 * Upstream's conversation for the sample, split into earlier turns and the live prompt. The
 * template's reminders (its own gitStatus and harness context) are dropped, because the real
 * harness adds its own; the case's notes stay. `prompt` is undefined for an empty-prompt case.
 */
export const splitConversation = (sample: Sample) => {
  const template = new Set(sample.base.reminders.flatMap((block) => textOf(block) ?? []));
  const kept = (block: Message["content"][number]) => {
    const text = textOf(block);
    return text === undefined || (!template.has(text) && !text.includes("\n# gitStatus\n"));
  };
  const messages = buildMessages(sample).map((message) => ({
    role: message.role,
    content: message.content.filter(kept),
  }));
  let prompt: string | undefined;
  if (sample.testCase.prompt !== "") {
    for (let m = messages.length - 1; m >= 0 && prompt === undefined; m--) {
      const message = messages[m]!;
      if (message.role !== "user") continue;
      const at = message.content.findLastIndex((block) => {
        const text = textOf(block);
        return text !== undefined && !text.startsWith("<system-reminder>");
      });
      if (at === -1) continue;
      prompt = textOf(message.content[at]!);
      message.content = message.content.toSpliced(at, 1);
    }
  }
  return { history: messages.filter((message) => message.content.length > 0), prompt };
};

const toolsOf = (toolkits: ReadonlyArray<{ readonly tools: Record<string, Tool.Any> }>) =>
  toolkits.flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));

/**
 * The tools each MCP server registers. `upstream` is upstream's eval list; `j5` is what J5's
 * server registers in McpHttpServer.layerTools, where J5's catalog replaces part of upstream's.
 */
const CATALOGS = {
  upstream: toolsOf([
    OrchestratorToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    WorktreeToolkit,
    PullRequestsToolkit,
    PreviewToolkit,
    DeviceToolkit,
    HtmlToolkit,
  ]),
  j5: toolsOf([
    PreviewToolkit,
    J5Toolkit,
    J5OrchestratorSurface,
    J5OrchestratorToolkit,
    J5ThreadToolkit,
    J5AdaptedThreadToolkit,
    J5AttachmentUploadToolkit,
    J5ProjectToolkit,
    J5EnvironmentToolkit,
    J5ArtifactToolkit,
    PreviewControlsToolkit,
    WorktreeToolkit,
    PullRequestsToolkit,
    DeviceToolkit,
    HtmlToolkit,
  ]),
};
export type Catalog = keyof typeof CATALOGS;
export const isCatalog = (value: string): value is Catalog => value in CATALOGS;

/**
 * The tools the server lists for this case's thread: each tool's own EnabledWhen rule, run with
 * the invocation context T3 would give the thread (child or not, links beta off unless the case
 * turns it on, not a link session).
 */
export const t3McpTools = (testCase: McpToolUseCase, catalog: Catalog) => {
  const scope = {
    thread: { subagent: testCase.setup.role === "delegated-child" },
    linkedEnvironments: testCase.setup.linkedEnvironments === true,
  } as unknown as McpInvocationContext.McpInvocationContext["Service"];
  const client = { protocolVersion: "2025-06-18", capabilities: {} };
  const enabled = (tool: Tool.Any) => {
    const rule = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
    return (
      rule === undefined ||
      Effect.runSync(
        Effect.sync(() => rule(client)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        ),
      )
    );
  };
  return CATALOGS[catalog].filter(enabled).map((tool) => ({
    name: tool.name,
    description: Tool.getDescription(tool) ?? "",
    inputSchema: advertisedJsonSchema(tool),
  }));
};

const EVAL_ENVIRONMENT_ID = EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

const withProductFields = (name: string, value: unknown, child: boolean): unknown => {
  if (!isRecord(value)) return value;
  const linked = (thread: unknown, idKey = "threadId") => {
    if (!isRecord(thread) || thread.link !== undefined) return thread;
    const id = thread[idKey] ?? thread.id;
    return typeof id === "string"
      ? {
          ...thread,
          link: formatThreadLink({
            environmentId: EVAL_ENVIRONMENT_ID,
            threadId: ThreadId.make(id),
          }),
        }
      : thread;
  };
  const listed = (key: string) =>
    Array.isArray(value[key]) ? { ...value, [key]: value[key].map((item) => linked(item)) } : value;
  switch (name) {
    case "delegate_task":
    case "task_status": {
      const task = linked(value, "childThreadId") as Record<string, unknown>;
      const running = task.status === "running" && task.next === undefined;
      return running ? { ...task, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : task;
    }
    case "t3_thread_read":
      return { ...value, thread: linked(value.thread) };
    case "t3_thread_launch":
    case "t3_thread_send":
    case "run_scheduled_task_now":
      return linked(value);
    case "t3_thread_list":
    case "create_threads":
      return listed("threads");
    case "t3_thread_search":
      return listed("matches");
    case "link_pull_request":
    case "link_pull_requests":
      return child ? { ...value, next: CHILD_PULL_REQUEST_REPORT_NEXT } : value;
    default:
      return value;
  }
};

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const codexCall = (name: string, input: unknown) => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash")
    return `text(await tools.exec_command(${JSON.stringify({ ...args, cmd: args.command })}));`;
  if (["Read", "Write", "Edit"].includes(name)) {
    const file = valueText(args.file_path);
    const command =
      name === "Read"
        ? `cat ${JSON.stringify(file)}`
        : name === "Write"
          ? `cat > ${JSON.stringify(file)} <<'EVAL_EOF'\n${valueText(args.content)}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${JSON.stringify(file)}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
  }
  return `text(await tools.${name.replace("mcp__t3-code__", "mcp__t3_code__")}(${JSON.stringify(input)}));`;
};

type Block = Readonly<Record<string, unknown>>;
/** Claude-shaped messages as Codex code-mode Responses items. */
export const codexMessages = (
  messages: ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Block> }>,
): Array<Block> =>
  messages.flatMap((message) =>
    message.content.map((block): Block =>
      block.type === "tool_use"
        ? {
            type: "custom_tool_call",
            call_id: block.id,
            name: "exec",
            input: codexCall(valueText(block.name), block.input),
          }
        : block.type === "tool_result"
          ? {
              type: "custom_tool_call_output",
              call_id: block.tool_use_id,
              output: valueText(block.content),
            }
          : {
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: valueText(block.text),
                },
              ],
            },
    ),
  );

/** Cases mock a Claude caller, so the inherited fields follow the model under test. */
const capabilities = (sample: Sample, value: unknown, codex: boolean, effort: string) =>
  isRecord(value)
    ? {
        ...value,
        inheritedModel: sample.base.model,
        ...(codex
          ? {
              inheritedProviderInstanceId: "codex",
              inheritedOptions: [{ id: "reasoningEffort", value: effort }],
            }
          : {}),
      }
    : value;

/**
 * T3's result for one call, as upstream answers it: device tools from the sample's device world,
 * then the case's mock, then upstream's default.
 */
export const t3Result = async (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
  options: { readonly codex: boolean; readonly effort: string },
): Promise<{ readonly value: unknown; readonly isError: boolean }> => {
  const { setup } = sample.testCase;
  const child = setup.role === "delegated-child";
  const mock = setup.mocks?.[name];
  // A mock that is a T3 device error fails inside T3's device tools, as upstream does.
  const failure = deviceFailure(mock);
  const fromWorld = mock === undefined || mock === "default" || failure !== undefined;
  if (sample.devices && isDeviceTool(name) && fromWorld) {
    const result = await Effect.runPromise(sample.devices.call(name, input, failure));
    return { value: result.text, isError: result.isError };
  }
  const shaped = (value: unknown) =>
    name === "orchestrator_capabilities"
      ? capabilities(sample, value, options.codex, options.effort)
      : withProductFields(name, value, child);
  if (mock !== undefined && mock !== "default") return { value: shaped(mock), isError: false };
  if (name === "watch_pull_request" && child) return { value: SUBAGENT_WATCH_ERROR, isError: true };
  const value = name.startsWith("j5_") ? j5Default(sample, name, input) : undefined;
  return { value: value ?? shaped(t3Default(sample, name, input)), isError: false };
};
