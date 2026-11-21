// @effect-diagnostics nodeBuiltinImport:off
/**
 * Shell and file calls never run as the agent wrote them. A PreToolUse hook asks this module for
 * the output (a case's canned output, else the simulator), writes it to a file, and rewrites the
 * call to print that file. The simulator is upstream's prompt on Claude Haiku, run by the SDK on
 * the same subscription as the agent.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cannedOutput, shellRequest } from "../mcp-tool-use/run.ts";
import { CLAUDE_BINARY, query } from "./sdk.ts";
import type { Sample } from "./upstream.ts";
import { addClaudeResult, emptyUsage, shellUsage } from "./usage.ts";

const SIM_DIR = "/tmp/eval-sim";
const SHELL_MODEL = "claude-haiku-5-5";
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Asks the simulator for one call's output, with upstream's prompt and reply schema. */
const simulateOutput = async (sample: Sample, call: { tool: string; input: unknown }) => {
  const body = shellRequest(sample, call, SHELL_MODEL);
  const prompt = body.messages[0]!.content.map((block) => String(block.text)).join("\n\n");
  let output = "";
  for await (const message of query({
    prompt,
    options: {
      model: SHELL_MODEL,
      systemPrompt: body.system,
      tools: [],
      effort: "low",
      // Structured output can take a retry or two inside the SDK.
      maxTurns: 6,
      persistSession: false,
      settingSources: [],
      cwd: "/tmp",
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
      outputFormat: { type: "json_schema", schema: body.output_config.format.schema },
    },
  })) {
    if (message.type === "result") {
      const used = shellUsage.get(sample) ?? emptyUsage();
      addClaudeResult(used, message);
      shellUsage.set(sample, used);
    }
    if (message.type === "result" && message.subtype === "success") {
      const reply = message.structured_output;
      output = isRecord(reply) && typeof reply.output === "string" ? reply.output : message.result;
    }
  }
  return output.trim();
};

let next = 0;
/**
 * The simulated output for one shell or file call, recorded in the sample's shell history so
 * later outputs stay consistent with it.
 */
export const simulate = async (sample: Sample, tool: string, input: Record<string, unknown>) => {
  const command = tool === "Bash" && typeof input.command === "string" ? input.command : undefined;
  let output = command === undefined ? undefined : cannedOutput(sample, command);
  output ??= await simulateOutput(sample, { tool, input });
  if (tool === "Bash" && output === "") output = "(Bash completed with no output)";
  sample.shell.push({ tool, input, output });
  NodeFS.mkdirSync(SIM_DIR, { recursive: true });
  const file = NodePath.join(SIM_DIR, `${next++}.out`);
  return { output, file };
};

/** A Bash command that prints the simulated output and exits as the simulator said. */
export const printCommand = (output: string, file: string) => {
  const failed = /^Exit code (\d+)\n?([\s\S]*)$/.exec(output);
  NodeFS.writeFileSync(file, failed ? failed[2]! : output);
  return failed ? `cat ${file} >&2; exit ${failed[1]}` : `cat ${file}`;
};

/** File contents from simulated `cat -n` style output, for a Read pointed at a file. */
export const fileContents = (output: string, file: string) => {
  NodeFS.writeFileSync(file, output.replace(/^ *\d+[\t→]/gm, ""));
  return file;
};
