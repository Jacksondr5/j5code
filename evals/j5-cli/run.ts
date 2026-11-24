#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
/**
 * Runs upstream's mcp-tool-use cases on the real Claude Code and Codex CLIs, inside the eval
 * container (start it with launch.ts). Each sample gets a fresh checkout at /home/user/app,
 * the fake T3 MCP server, and upstream's grader.
 *
 * Flags are in README.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import {
  gradeSample,
  pastedText,
  worldFilePaths,
  type McpToolUseCase,
  type SampleRun,
  withDevices,
} from "../mcp-tool-use/run.ts";
import { runClaude } from "./claude.ts";
import { runCodex } from "./codex.ts";
import { gradeSteer, steerFor } from "./steer.ts";
import { emptyUsage, shellUsage, type Usage } from "./usage.ts";
import { type McpSample, startMcpServer } from "./mcp.ts";
import {
  DATE_DEPENDENT,
  isCatalog,
  loadCases,
  sampleFor,
  splitConversation,
  UNSUPPORTED_DATE,
} from "./upstream.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    case: { type: "string", multiple: true },
    harness: { type: "string", default: "claude" },
    model: { type: "string" },
    effort: { type: "string", default: "high" },
    samples: { type: "string" },
    baseline: { type: "string" },
    "stop-on-regression": { type: "boolean", default: false },
    "max-turns": { type: "string", default: "8" },
    "timeout-minutes": { type: "string", default: "10" },
    catalog: { type: "string", default: "j5" },
    shard: { type: "string" },
    merge: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const harness = values.harness === "codex" ? "codex" : "claude";
const model = values.model ?? (harness === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5");
if (values.out === undefined && !values["dry-run"]) throw new Error("Pass --out <dir>.");
const catalog = values.catalog;
if (!isCatalog(catalog)) throw new Error("--catalog is j5 or upstream.");
const out = NodePath.resolve(values.out ?? ".");
const CWD = "/home/user/app";
const MAIN_COMMITS = [
  "chore: update dependencies",
  "fix(server): retry provider start once on ENOENT",
  "feat(web): show the model name in the thread header",
];

/** A real checkout matching the case's world, so the harness's own git context agrees with it. */
const makeCheckout = (testCase: McpToolUseCase) => {
  NodeFS.rmSync(CWD, { recursive: true, force: true });
  NodeFS.mkdirSync(CWD, { recursive: true });
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", CWD, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.test");
  git("config", "user.name", "Acme Dev");
  git(
    "remote",
    "add",
    "origin",
    `https://github.com/${testCase.setup.world?.repo ?? "acme/app"}.git`,
  );
  for (const subject of MAIN_COMMITS) git("commit", "-q", "--allow-empty", "-m", subject);
  const branch = testCase.setup.world?.branch;
  if (branch && branch !== "main") {
    git("checkout", "-q", "-b", branch);
    for (const { subject } of [...(testCase.setup.world?.commits ?? [])].reverse()) {
      git("commit", "-q", "--allow-empty", "-m", subject);
    }
  }
};

// Codex has no native subagents; like upstream, its native-subagent cases run as top-level threads.
// `--shard i/n` runs every n-th case from i, so launch.ts can split a run across containers.
const [shardIndex = 0, shardCount = 1] = (values.shard ?? "0/1").split("/").map(Number);
const cases = loadCases(values.case ?? [], catalog)
  .filter((testCase) => (testCase.setup.harness ?? harness) === harness)
  .filter((_, index) => index % shardCount === shardIndex);
if (cases.length === 0 && !values.merge) throw new Error("No case matches --case.");
// Prints the conversation each case hands the harness, without starting a CLI or a container.
if (values["dry-run"]) {
  for (const testCase of cases) {
    const { history, prompt } = splitConversation(sampleFor(testCase, model, catalog));
    const steer = steerFor(testCase);
    console.log(JSON.stringify({ id: testCase.id, history, prompt, steer }, null, 2));
  }
  process.exit(0);
}
if (values["stop-on-regression"] && values.baseline === undefined) {
  throw new Error("--stop-on-regression needs --baseline.");
}

type Row = {
  readonly id: string;
  readonly kind: McpToolUseCase["kind"];
  readonly pass: boolean;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly usage?: Usage | undefined;
  readonly shellUsage?: Usage | undefined;
  readonly [key: string]: unknown;
};

/** The share of samples that passed; errored samples are left out, NaN if all errored. */
const passRate = (rows: ReadonlyArray<Pick<Row, "pass" | "error">>) => {
  const finished = rows.filter((row) => row.error === undefined);
  return finished.filter((row) => row.pass).length / finished.length;
};
const readRows = (file: string): ReadonlyArray<Row> =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);
const baseline = new Map(
  [...Map.groupBy(values.baseline ? readRows(values.baseline) : [], (row) => row.id)]
    .map(([id, rows]) => [id, passRate(rows)] as const)
    .filter(([, rate]) => !Number.isNaN(rate)),
);
// Only a case that passed every baseline sample can stop a run; flaky ones are just reported.
const passedBefore = (id: string) => baseline.get(id) === 1;

/** Runs this shard's cases, or with `--merge` collects the shards' results under `--out`. */
const collect = async (): Promise<{ rows: Array<Row>; regressions: Array<string> }> => {
  if (values.merge) {
    const shards = NodeFS.readdirSync(out)
      .filter((name) => name.startsWith("shard-"))
      .map((name) => NodePath.join(out, name));
    const rows = shards.flatMap((dir) => [...readRows(NodePath.join(dir, "results.jsonl"))]);
    NodeFS.writeFileSync(
      NodePath.join(out, "results.jsonl"),
      rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
    );
    const regressions = shards.flatMap((dir) => {
      const file = NodePath.join(dir, "stopped.txt");
      return NodeFS.existsSync(file) ? [NodeFS.readFileSync(file, "utf8")] : [];
    });
    return { rows, regressions };
  }
  const mcp = await startMcpServer();
  NodeFS.mkdirSync(out, { recursive: true });
  const resultsFile = NodePath.join(out, "results.jsonl");
  NodeFS.writeFileSync(resultsFile, "");

  let nextSample = 0;
  const runOne = async (testCase: McpToolUseCase): Promise<Row> => {
    const key = `s${nextSample++}`;
    const sample = sampleFor(testCase, model, catalog);
    makeCheckout(testCase);
    const answered: Array<{ tool: string; input: unknown }> = [];
    const entry: McpSample = {
      sample,
      codex: harness === "codex",
      effort: values.effort,
      catalog,
      answered,
    };
    const options = {
      model,
      cwd: CWD,
      mcpUrl: mcp.register(key, entry),
      hookUrl: mcp.hookUrl(key),
      setHook: (hook: NonNullable<McpSample["hook"]>) => {
        entry.hook = hook;
      },
      maxTurns: testCase.maxSteps ?? Number(values["max-turns"]),
      effort: values.effort,
      signal: AbortSignal.timeout(Number(values["timeout-minutes"]) * 60_000),
    };
    let run: (SampleRun & { readonly usage: Usage }) | undefined;
    let error: string | undefined;
    const startedAt = Date.now();
    // Upstream's fake device hosts live for the sample, in this scope.
    const deviceScope = Scope.makeUnsafe();
    try {
      if (DATE_DEPENDENT.has(testCase.id)) throw new Error(UNSUPPORTED_DATE);
      await Effect.runPromise(
        withDevices(sample).pipe(
          Scope.provide(deviceScope),
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      );
      run =
        harness === "codex" ? await runCodex(sample, options) : await runClaude(sample, options);
    } catch (cause) {
      error = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    } finally {
      await Effect.runPromise(Scope.close(deviceScope, Exit.void));
    }
    const durationMs = Date.now() - startedAt;
    const steer = steerFor(testCase);
    const checks = run
      ? [
          ...gradeSample(testCase.expect, run, pastedText(testCase), worldFilePaths(testCase)),
          ...(steer ? gradeSteer(steer, run) : []),
        ]
      : [];
    const pass = run !== undefined && checks.every((check) => check.pass);
    const row: Row = {
      id: testCase.id,
      kind: testCase.kind,
      role: testCase.setup.role,
      harness,
      model,
      catalog,
      pass,
      durationMs,
      checks,
      run,
      answered,
      shell: sample.shell,
      usage: run?.usage,
      shellUsage: shellUsage.get(sample),
      error,
    };
    NodeFS.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
    const status = error?.startsWith("Error: Unsupported:")
      ? "UNSUPPORTED"
      : error
        ? "ERROR"
        : pass
          ? "PASS"
          : "FAIL";
    console.log(
      `${status} ${testCase.id} ${Math.round(durationMs / 1000)}s${error ? ` ${error.split("\n")[0]}` : ""}`,
    );
    for (const check of checks) if (!check.pass) console.log(`  FAIL ${check.check}`);
    return row;
  };

  // Without --samples, a case whose 2 samples disagree gets a 3rd to settle it, as upstream does.
  const runCase = async (testCase: McpToolUseCase) => {
    const rows: Array<Row> = [];
    for (let n = 0; n < Number(values.samples ?? 2); n++) rows.push(await runOne(testCase));
    const split = values.samples === undefined && new Set(rows.map((row) => row.pass)).size > 1;
    if (split) rows.push(await runOne(testCase));
    return rows;
  };

  const ordered = values["stop-on-regression"]
    ? cases.toSorted((a, b) => Number(passedBefore(b.id)) - Number(passedBefore(a.id)))
    : cases;
  const rows: Array<Row> = [];
  const regressions: Array<string> = [];
  for (const testCase of ordered) {
    const caseRows = await runCase(testCase);
    rows.push(...caseRows);
    if (values["stop-on-regression"] && passedBefore(testCase.id) && passRate(caseRows) <= 0.5) {
      regressions.push(testCase.id);
      NodeFS.writeFileSync(NodePath.join(out, "stopped.txt"), testCase.id);
      break;
    }
  }
  mcp.close();
  return { rows, regressions };
};
const { rows, regressions } = await collect();

const percent = (rate: number) => (Number.isNaN(rate) ? "-" : `${Math.round(rate * 100)}%`);
const table = (title: string, key: (row: Row) => string, compare: boolean) => [
  `## ${title}\n`,
  compare ? "| Group | Pass | Baseline |" : "| Group | Pass |",
  compare ? "| --- | --- | --- |" : "| --- | --- |",
  ...[...Map.groupBy(rows, key)]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => {
      const errored = members.filter((row) => row.error !== undefined).length;
      const pass = `${percent(passRate(members))} of ${members.length - errored}${errored ? `, ${errored} errored` : ""}`;
      return `| ${group} | ${pass} |${compare ? ` ${percent(baseline.get(group) ?? Number.NaN)} |` : ""}`;
    }),
  "",
];
// The worktree's git data is outside the container, so launch.ts passes the commit in.
const commit = process.env.EVAL_COMMIT ?? "unknown";
const minutes = Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / 60_000);
const total = (usages: ReadonlyArray<Usage | undefined>) => {
  const sum = emptyUsage();
  for (const usage of usages) {
    sum.inputTokens += usage?.inputTokens ?? 0;
    sum.cachedInputTokens += usage?.cachedInputTokens ?? 0;
    sum.outputTokens += usage?.outputTokens ?? 0;
    sum.apiCostUsd += usage?.apiCostUsd ?? 0;
  }
  return sum;
};
const usageLine = (label: string, usage: Usage, priced: boolean) =>
  `- ${label}: ${usage.inputTokens} input, ${usage.cachedInputTokens} cached and ${usage.outputTokens} output tokens${priced ? `, about $${usage.apiCostUsd.toFixed(2)} at API prices (billed to the subscription)` : ""}.`;
const summary = [
  "# MCP tool use on the real CLIs\n",
  `- Commit \`${commit}\`, ${harness} ${model} at ${values.effort} effort, ${catalog} catalog, ${values.samples ?? "2-3 (adaptive)"} samples per case.`,
  `- Pass: ${percent(passRate(rows))} of ${rows.filter((row) => row.error === undefined).length} samples. ${minutes} minutes of samples.`,
  ...(rows.some((row) => row.error)
    ? [
        `- Errored (not graded): ${[...new Set(rows.filter((row) => row.error).map((row) => row.id))].join(", ")}.`,
      ]
    : []),
  usageLine(`Agent (${model})`, total(rows.map((row) => row.usage)), harness === "claude"),
  usageLine("Shell simulator (claude-haiku-5-5)", total(rows.map((row) => row.shellUsage)), true),
  ...regressions.map((id) => `- Stopped at \`${id}\`, which passed every baseline sample.`),
  "",
  ...table("Cases", (row) => row.id, baseline.size > 0),
  ...table("By kind", (row) => row.kind, false),
].join("\n");
NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
console.log(`\n${summary}`);
