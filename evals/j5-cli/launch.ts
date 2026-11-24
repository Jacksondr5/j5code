#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Host side of the CLI eval: builds the pinned image, starts the egress proxy on an internal Docker
 * network, and runs commands in a container that can reach only the model providers. See README.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.resolve(here, "../..");
const dockerfile = NodeFS.readFileSync(NodePath.join(here, "Dockerfile"), "utf8");
const pinned = (name: string) =>
  new RegExp(`ARG ${name}=(\\S+)`).exec(dockerfile)?.[1] ?? "unknown";
const image = `j5-eval-cli:claude-${pinned("CLAUDE_CODE_VERSION")}-codex-${pinned("CODEX_VERSION")}`;
// Names carry this checkout's hash so evals in two worktrees never share a network or proxy.
const id = NodeCrypto.createHash("sha256").update(repo).digest("hex").slice(0, 8);
const network = `j5-eval-${id}-internal`;
const proxy = `j5-eval-${id}-egress`;
const codexVolume = "j5-eval-codex-home";
const ALLOW = ["api.anthropic.com", "chatgpt.com", "auth.openai.com"];

const docker = (args: ReadonlyArray<string>, options: { quiet?: boolean } = {}) => {
  const result = NodeChildProcess.spawnSync("docker", args, {
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};
const exists = (kind: "network" | "container", name: string) =>
  docker([kind, "inspect", name], { quiet: true }).status === 0;

const build = () => {
  const uid = String(process.getuid?.() ?? 1000);
  if (docker(["build", "--build-arg", `UID=${uid}`, "-t", image, here]).status !== 0)
    process.exit(1);
};

const up = () => {
  if (docker(["image", "inspect", image], { quiet: true }).status !== 0) build();
  if (!exists("network", network)) docker(["network", "create", "--internal", network]);
  if (exists("container", proxy)) return;
  const started = docker([
    "run",
    "-d",
    "--name",
    proxy,
    "--network",
    "bridge",
    "-e",
    `EGRESS_ALLOW=${ALLOW.join(",")}`,
    "-v",
    `${NodePath.join(here, "egress-proxy.ts")}:/proxy.ts:ro`,
    image,
    "node",
    "/proxy.ts",
  ]);
  if (started.status !== 0) process.exit(1);
  docker(["network", "connect", network, proxy]);
};

const down = () => {
  if (exists("container", proxy)) docker(["rm", "-f", proxy], { quiet: true });
  if (exists("network", network)) docker(["network", "rm", network], { quiet: true });
};

let calls = 0;
/** Runs one command in a fresh runner container on the internal network; resolves its exit code. */
const inContainer = async (command: ReadonlyArray<string>, interactive: boolean) => {
  up();
  const out = NodePath.join(repo, "evals/runs");
  NodeFS.mkdirSync(out, { recursive: true });
  const envFile = NodePath.join(NodeOS.tmpdir(), `j5-eval-${id}-${process.pid}-${calls++}.env`);
  const commit = NodeChildProcess.spawnSync(
    "git",
    ["-C", repo, "describe", "--always", "--dirty"],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
  const lines = [
    `HTTPS_PROXY=http://${proxy}:3128`,
    `https_proxy=http://${proxy}:3128`,
    `EVAL_COMMIT=${commit || "unknown"}`,
  ];
  const tokenFile = process.env.CLAUDE_TOKEN_FILE;
  if (tokenFile) {
    lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${NodeFS.readFileSync(tokenFile, "utf8").trim()}`);
  }
  NodeFS.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  const child = NodeChildProcess.spawn(
    "docker",
    [
      "run",
      "--rm",
      ...(interactive ? ["-it"] : ["-i"]),
      "--network",
      network,
      "--env-file",
      envFile,
      // The checkout keeps its own path, so pnpm's links and source imports resolve unchanged.
      "-v",
      `${repo}:${repo}:ro`,
      "-v",
      `${out}:${out}`,
      "-v",
      `${codexVolume}:/home/user/.codex`,
      "-w",
      repo,
      image,
      ...command,
    ],
    { stdio: "inherit" },
  );
  try {
    return await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    NodeFS.rmSync(envFile, { force: true });
  }
};

/**
 * `run`: with `--shards n`, n containers each run every n-th case, so samples run in parallel with
 * their own checkout and Claude home; the Codex login volume is shared, as on one machine.
 */
const run = async (flags: ReadonlyArray<string>) => {
  const runner = ["node", NodePath.join(here, "run.ts")];
  const at = flags.indexOf("--shards");
  const shards = at === -1 ? 1 : Number(flags[at + 1]);
  const rest = at === -1 ? flags : flags.toSpliced(at, 2);
  if (shards <= 1) return inContainer([...runner, ...rest], false);
  const outAt = rest.indexOf("--out");
  const out = rest[outAt + 1];
  if (outAt === -1 || out === undefined) throw new Error("Pass --out <dir>.");
  const codes = await Promise.all(
    Array.from({ length: shards }, (_, i) =>
      inContainer(
        [
          ...runner,
          ...rest.toSpliced(outAt, 2),
          "--shard",
          `${i}/${shards}`,
          "--out",
          `${out}/shard-${i}`,
        ],
        false,
      ),
    ),
  );
  const merged = await inContainer([...runner, ...rest, "--merge"], false);
  return Math.max(merged, ...codes);
};

const [command, ...rest] = process.argv.slice(2);
const passed = rest[0] === "--" ? rest.slice(1) : rest;
switch (command) {
  case "build":
    build();
    break;
  case "down":
    down();
    break;
  case "login-codex":
    process.exit(await inContainer(["codex", "login", "--device-auth"], true));
    break;
  case "logs":
    docker(["logs", proxy]);
    break;
  case "exec":
    process.exit(await inContainer(passed, process.stdin.isTTY === true));
    break;
  case "run":
    process.exit(await run(passed));
    break;
  default:
    console.error(
      "Usage: launch.ts build | login-codex | run -- <flags> | exec -- <cmd> | logs | down",
    );
    process.exit(2);
}
