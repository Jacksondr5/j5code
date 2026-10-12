// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a standalone Node CLI that manages one child process group and prints instructions.
/**
 * One command for an agent that needs to live-test J5 Code:
 *
 *   node scripts/j5/setup-agent-live-test.ts            build the test home if needed, start the server
 *   node scripts/j5/setup-agent-live-test.ts status     say whether it is running, and how to reach it
 *   node scripts/j5/setup-agent-live-test.ts restart    stop, then start on the same home
 *   node scripts/j5/setup-agent-live-test.ts stop       stop the server
 *
 * Everything lives in this worktree's gitignored `.j5code/live-test`: a small
 * test repository, a J5 home that holds only that project, the server's log
 * and the record of its process group. Nothing there points at a real
 * repository, the developer's data or the live install. It refuses to run
 * outside a linked git worktree.
 *
 * `stop` signals only the process group this script started, and only after
 * confirming that group still owns the server's port from inside this
 * worktree. It never finds a process by name. Linux only: it reads `/proc`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveGitWorktreePath } from "@t3tools/shared/devHome";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const COMMANDS = ["start", "status", "restart", "stop"] as const;
type LiveTestCommand = (typeof COMMANDS)[number];

/** The live install's port. A test server must never end up on it. */
const LIVE_SERVER_PORT = 5773;
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;
const RECOVERY_LOG_LINE = "V2 orchestration recovery completed";

/** A reason this script will not act, printed as-is. */
export class LiveTestRefusal extends Error {}

interface Manifest {
  readonly home: string;
  readonly testRepo: string;
  readonly project: { readonly title: string };
  readonly defaultModel: string;
  readonly personas: ReadonlyArray<{ readonly id: string; readonly model: string }>;
  readonly playbooks: ReadonlyArray<string>;
  readonly holdScript: string;
  readonly holdReleaseFile: string;
}

export interface LiveTestPaths {
  readonly worktree: string;
  readonly root: string;
  readonly manifest: string;
  readonly log: string;
  readonly record: string;
}

const isInside = (candidate: string, parent: string) => {
  const relative = NodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** `target` with every symlink in its existing part resolved; the rest may not exist yet. */
const canonicalPath = (target: string): string => {
  let existing = NodePath.resolve(target);
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return NodePath.resolve(
    NodeFS.realpathSync(existing),
    NodePath.relative(existing, NodePath.resolve(target)),
  );
};

/**
 * Where the live-test state for `checkout` lives, or a refusal. `checkout`
 * must be the root of a linked git worktree, and its `.j5code/live-test` must
 * really be inside it and must not be a live home's state.
 */
export async function resolveLiveTestPaths(input: {
  readonly checkout: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<LiveTestPaths> {
  const checkout = NodePath.resolve(input.checkout);
  const worktree = await Effect.runPromise(
    resolveGitWorktreePath(checkout).pipe(Effect.provide(NodeServices.layer)),
  );
  if (worktree !== checkout) {
    throw new LiveTestRefusal(
      `${checkout} is not a linked git worktree. Live tests run only from a worktree, never from the main checkout: create one with \`git worktree add\` and run this script there.`,
    );
  }
  const root = NodePath.join(worktree, ".j5code", "live-test");
  const canonicalRoot = canonicalPath(root);
  if (!isInside(canonicalRoot, NodePath.join(NodeFS.realpathSync(worktree), ".j5code"))) {
    throw new LiveTestRefusal(
      `${root} resolves to ${canonicalRoot}, outside this worktree's .j5code. Remove the symlink; the test home must live inside the worktree.`,
    );
  }
  const liveHomes = [
    NodePath.join(input.homeDirectory, ".j5code"),
    ...(input.environment.J5CODE_HOME?.trim() ? [input.environment.J5CODE_HOME.trim()] : []),
  ].map(canonicalPath);
  for (const liveHome of liveHomes) {
    // A worktree's own .j5code may sit below ~/.j5code/worktrees. The live home
    // itself, and its state directory, are never a test home.
    if (
      isInside(liveHome, NodePath.dirname(canonicalRoot)) ||
      isInside(canonicalRoot, NodePath.join(liveHome, "userdata"))
    ) {
      throw new LiveTestRefusal(
        `${root} is the live home ${liveHome} or inside its state. Refusing to build or start a test server there.`,
      );
    }
  }
  return {
    worktree,
    root,
    manifest: NodePath.join(root, "manifest.json"),
    log: NodePath.join(root, "server.log"),
    record: NodePath.join(root, "server.json"),
  };
}

/** The environment for anything started here: nothing inherited from the live server. */
export function liveTestEnvironment(
  environment: NodeJS.ProcessEnv,
  worktree: string,
): NodeJS.ProcessEnv {
  const {
    T3CODE_PORT: _port,
    T3CODE_HOST: _host,
    J5CODE_HOME: _home,
    J5CODE_SERVER_NAME: _name,
    ...rest
  } = environment;
  return {
    ...rest,
    // Without this the dev server registers <worktree>/apps/server as a project.
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    // The dev runner spawns `vp`, which is often not on an agent's PATH.
    PATH: [NodePath.join(worktree, "node_modules", ".bin"), rest.PATH ?? ""].join(
      NodePath.delimiter,
    ),
  };
}

export interface ServerLogFacts {
  readonly serverPort: number | undefined;
  readonly webPort: number | undefined;
  readonly baseDir: string | undefined;
  readonly pairingUrl: string | undefined;
  readonly recovered: boolean;
}

/** What the dev server's log says so far. The latest pairing URL wins: a file-watch restart mints a new one. */
export function readServerLog(log: string): ServerLogFacts {
  // eslint-disable-next-line no-control-regex -- the server's pretty logger colours its output.
  const text = log.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const runner = /\[dev-runner\] .*serverPort=(\d+) webPort=(\d+) baseDir=(\S+)/.exec(text);
  const pairingUrls = [...text.matchAll(/pairingUrl: (\S+)/g)];
  return {
    serverPort: runner === null ? undefined : Number(runner[1]),
    webPort: runner === null ? undefined : Number(runner[2]),
    baseDir: runner?.[3],
    pairingUrl: pairingUrls.at(-1)?.[1],
    recovered: text.includes(RECOVERY_LOG_LINE),
  };
}

/** The process group of `pid`, or undefined when it is gone. */
function processGroupOf(pid: number): number | undefined {
  try {
    // /proc/<pid>/stat is "pid (comm) state ppid pgrp ..."; comm may hold spaces and parentheses.
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return undefined;
  }
}

function membersOfGroup(group: number): ReadonlyArray<number> {
  return NodeFS.readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => processGroupOf(pid) === group);
}

function listenerOn(port: number): number | undefined {
  const output = NodeChildProcess.execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
    encoding: "utf8",
  });
  const pid = /pid=(\d+)/.exec(output)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

export type ServerState =
  | { readonly kind: "stopped" }
  | { readonly kind: "running"; readonly group: number; readonly facts: ServerLogFacts }
  | { readonly kind: "unverified"; readonly group: number; readonly reason: string };

/**
 * Decides whether the recorded process group is this worktree's test server.
 * It is only when the listener on the port its log reports belongs to that
 * group and runs from inside the worktree. A group that is alive but fails
 * that check is reported, never signalled.
 */
export function classifyServer(input: {
  readonly worktree: string;
  readonly group: number | undefined;
  readonly facts: ServerLogFacts;
  readonly groupMembers: (group: number) => ReadonlyArray<number>;
  readonly listenerOn: (port: number) => number | undefined;
  readonly processGroupOf: (pid: number) => number | undefined;
  readonly cwdOf: (pid: number) => string | undefined;
}): ServerState {
  const { group, facts } = input;
  if (group === undefined) return { kind: "stopped" };
  const members = input.groupMembers(group);
  if (members.length === 0) return { kind: "stopped" };
  const unverified = (reason: string): ServerState => ({
    kind: "unverified",
    group,
    reason: `${reason} Process group ${group} still has processes (${members.join(", ")}); this script will not signal them. Inspect with \`ps -o pid,pgid,args -g ${group}\`.`,
  });
  if (facts.serverPort === undefined) {
    return unverified("The server log does not report a port yet.");
  }
  const listener = input.listenerOn(facts.serverPort);
  if (listener === undefined) {
    return unverified(`Nothing is listening on port ${facts.serverPort}.`);
  }
  if (input.processGroupOf(listener) !== group) {
    return unverified(
      `Port ${facts.serverPort} is owned by process ${listener}, which is not in the recorded group.`,
    );
  }
  const cwd = input.cwdOf(listener);
  if (cwd === undefined || !isInside(cwd, input.worktree)) {
    return unverified(
      `The listener on port ${facts.serverPort} runs from ${cwd ?? "an unknown directory"}, not from this worktree.`,
    );
  }
  return { kind: "running", group, facts };
}

function currentServerState(paths: LiveTestPaths): ServerState {
  const group = NodeFS.existsSync(paths.record)
    ? (JSON.parse(NodeFS.readFileSync(paths.record, "utf8")) as { processGroup: number })
        .processGroup
    : undefined;
  return classifyServer({
    worktree: NodeFS.realpathSync(paths.worktree),
    group,
    facts: readServerLog(
      NodeFS.existsSync(paths.log) ? NodeFS.readFileSync(paths.log, "utf8") : "",
    ),
    groupMembers: membersOfGroup,
    listenerOn,
    processGroupOf,
    cwdOf: (pid) => {
      try {
        return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return undefined;
      }
    },
  });
}

const selfCommand = (paths: LiveTestPaths, command: string) =>
  `node ${NodePath.join(paths.worktree, "scripts/j5/setup-agent-live-test.ts")} ${command}`.trimEnd();

/** Everything an agent needs to use the running server, with no other guidance. */
export function formatInstructions(input: {
  readonly paths: LiveTestPaths;
  readonly manifest: Manifest;
  readonly facts: ServerLogFacts;
}): string {
  const { paths, manifest, facts } = input;
  return `J5 Code live-test server: RUNNING

  Pairing URL   ${facts.pairingUrl}
  Web           http://localhost:${facts.webPort}
  Server port   ${facts.serverPort}
  Home          ${manifest.home}
  Log           ${paths.log}

Open the pairing URL in the Browser panel, then wait for [data-testid="composer-editor"].
The pairing URL works once. For another: node apps/server/src/bin.ts pair --base-dir ${manifest.home}

Project to use: "${manifest.project.title}"
  ${manifest.testRepo}
  A small TODO app (\`npm test\` runs its suite). Its origin is a local bare
  repository, so pushes go nowhere real. It is the only project in this home.
  Do not add another project: that is how a test reaches a real repository.

Pre-made threads are for viewing only. They are replayed recordings, so a
message sent in one fails or starts a new provider conversation. Take live
turns in a NEW thread in "${manifest.project.title}".
Known fault: in "New worktree" mode the server can interrupt a thread's first
turn a few seconds in (it reads "Run interrupted by user"). Use "Current
checkout" unless the worktree itself is what you are testing.

Models: new threads default to ${manifest.defaultModel}. Claude Haiku and GPT Luna
need no permission. Ask your Captain before a turn on anything more expensive.
Personas: ${manifest.personas.map((persona) => `${persona.id} (${persona.model})`).join(", ")}
Playbooks: ${manifest.playbooks.join(", ")}

To hold a turn open, ask the agent to run: ${manifest.holdScript}
It blocks until you release it with: touch ${manifest.holdReleaseFile}
The script deletes that file as it exits, so there is nothing to clean up.

Commands:
  ${selfCommand(paths, "status")}
  ${selfCommand(paths, "restart")}   stops, starts on the same home, returns once recovery has run
  ${selfCommand(paths, "stop")}
Stop the server when you finish. To rebuild from scratch: stop, then rm -rf ${paths.root}
`;
}

function readManifest(paths: LiveTestPaths): Manifest {
  return JSON.parse(NodeFS.readFileSync(paths.manifest, "utf8")) as Manifest;
}

function logTail(paths: LiveTestPaths): string {
  return NodeFS.readFileSync(paths.log, "utf8").split("\n").slice(-40).join("\n");
}

function buildHome(paths: LiveTestPaths): void {
  if (NodeFS.existsSync(paths.root)) {
    throw new LiveTestRefusal(
      `${paths.root} exists but holds no finished build. Delete it and run this again: rm -rf ${paths.root}`,
    );
  }
  if (!NodeFS.existsSync(NodePath.join(paths.worktree, "node_modules"))) {
    throw new LiveTestRefusal(
      `${paths.worktree} has no node_modules. Install first: vp i (or pnpm install).`,
    );
  }
  console.log("Building the test repository and home (about 30 seconds, no model calls)...");
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "apps/server/src/j5/test-support/liveTestHome.ts"),
      "--root",
      paths.root,
    ],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (build.status !== 0) {
    throw new LiveTestRefusal(
      `Building the test home failed. Delete ${paths.root} before retrying.`,
    );
  }
}

async function start(paths: LiveTestPaths): Promise<void> {
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "running") {
    console.log(formatInstructions({ paths, manifest: readManifest(paths), facts: state.facts }));
    return;
  }
  if (!NodeFS.existsSync(paths.manifest)) buildHome(paths);
  const manifest = readManifest(paths);

  const log = NodeFS.openSync(paths.log, "w");
  // Detached makes the child the leader of a new process group, so its pid is
  // the group id. That group is the only thing `stop` ever signals.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(paths.worktree, "scripts/dev-runner.ts"), "dev", "--home-dir", manifest.home],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  NodeFS.closeSync(log);
  const group = child.pid;
  if (group === undefined) throw new LiveTestRefusal("The dev server could not be spawned.");
  NodeFS.writeFileSync(paths.record, `${JSON.stringify({ processGroup: group })}\n`);
  child.unref();

  const abandon = (reason: string): never => {
    // This is the group spawned a moment ago, so signalling it needs no further proof.
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      // Already gone.
    }
    NodeFS.rmSync(paths.record, { force: true });
    throw new LiveTestRefusal(`${reason}\nLast lines of ${paths.log}:\n${logTail(paths)}`);
  };

  console.log("Starting the dev server...");
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const facts = readServerLog(NodeFS.readFileSync(paths.log, "utf8"));
    if (
      facts.baseDir !== undefined &&
      canonicalPath(facts.baseDir) !== canonicalPath(manifest.home)
    ) {
      abandon(`The dev server chose ${facts.baseDir}, not the test home ${manifest.home}.`);
    }
    if (
      facts.serverPort === LIVE_SERVER_PORT ||
      (facts.serverPort !== undefined && String(facts.serverPort) === process.env.T3CODE_PORT)
    ) {
      abandon(`The dev server chose the live server's port ${facts.serverPort}.`);
    }
    if (facts.pairingUrl !== undefined && facts.recovered) {
      const running = currentServerState(paths);
      if (running.kind === "running") {
        console.log(formatInstructions({ paths, manifest, facts: running.facts }));
        return;
      }
    }
    if (membersOfGroup(group).length === 0) abandon("The dev server exited while starting.");
    if (Date.now() > deadline) {
      abandon(`The dev server was not ready after ${START_TIMEOUT_MS / 1000} seconds.`);
    }
    await NodeTimersPromises.setTimeout(250);
  }
}

async function stop(paths: LiveTestPaths): Promise<void> {
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "stopped") {
    NodeFS.rmSync(paths.record, { force: true });
    console.log("J5 Code live-test server: STOPPED (it was not running)");
    return;
  }
  const waitForExit = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (membersOfGroup(state.group).length > 0) {
      if (Date.now() > deadline) return false;
      await NodeTimersPromises.setTimeout(200);
    }
    return true;
  };
  process.kill(-state.group, "SIGTERM");
  if (!(await waitForExit(STOP_TIMEOUT_MS))) {
    console.log(`Still running after ${STOP_TIMEOUT_MS / 1000} seconds; killing the group.`);
    process.kill(-state.group, "SIGKILL");
    if (!(await waitForExit(5_000))) {
      throw new LiveTestRefusal(
        `Process group ${state.group} survived SIGKILL: ${membersOfGroup(state.group).join(", ")}.`,
      );
    }
  }
  NodeFS.rmSync(paths.record, { force: true });
  console.log("J5 Code live-test server: STOPPED");
}

function status(paths: LiveTestPaths): void {
  const state = currentServerState(paths);
  if (state.kind === "unverified") throw new LiveTestRefusal(state.reason);
  if (state.kind === "running") {
    console.log(formatInstructions({ paths, manifest: readManifest(paths), facts: state.facts }));
    return;
  }
  console.log(
    `J5 Code live-test server: STOPPED\n\n${
      NodeFS.existsSync(paths.manifest)
        ? `The test home is built at ${paths.root}.`
        : "No test home is built yet."
    }\nStart it with: ${selfCommand(paths, "")}`,
  );
}

export function parseCommand(args: ReadonlyArray<string>): LiveTestCommand {
  const [command = "start", ...rest] = args;
  if (rest.length > 0 || !COMMANDS.some((known) => known === command)) {
    throw new LiveTestRefusal(
      `Usage: node scripts/j5/setup-agent-live-test.ts [${COMMANDS.join(" | ")}]`,
    );
  }
  return command as LiveTestCommand;
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone CLI with no Effect runtime.
  if (NodeOS.platform() !== "linux") {
    throw new LiveTestRefusal("This script reads /proc and runs only on Linux.");
  }
  const paths = await resolveLiveTestPaths({
    checkout: NodePath.resolve(import.meta.dirname, "../.."),
    homeDirectory: NodeOS.homedir(),
    environment: process.env,
  });
  if (command === "status") return status(paths);
  if (command === "stop") return stop(paths);
  if (command === "restart") await stop(paths);
  await start(paths);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    if (!(cause instanceof LiveTestRefusal)) throw cause;
    console.error(cause.message);
    process.exitCode = 1;
  });
}
