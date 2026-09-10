// @effect-diagnostics nodeBuiltinImport:off - native Git/process boundary also used by publication fixtures; Effect owns scheduling above this adapter.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { hash } from "../../workflow/Definition.ts";

const commandSignal = new NodeAsyncHooks.AsyncLocalStorage<AbortSignal>();
export const withCommandSignal = <A>(
  signal: AbortSignal,
  operation: () => Promise<A>,
): Promise<A> => commandSignal.run(signal, operation);

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeRuntime = Schema.decodeUnknownSync(Schema.Struct({ node_path: Schema.String }));
export async function command(
  cwd: string,
  executable: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<{ exitCode: number; output: string }> {
  const signal = options.signal ?? commandSignal.getStore();
  signal?.throwIfAborted();
  try {
    const result = await exec(executable, [...args], {
      cwd,
      env: options.env ?? process.env,
      ...(signal ? { signal } : {}),
      timeout: 1_800_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, output: result.stdout + result.stderr };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number"
    ) {
      return {
        exitCode: error.code,
        output:
          String("stdout" in error ? error.stdout : "") +
          String("stderr" in error ? error.stderr : ""),
      };
    }
    throw error;
  }
}
export async function git(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await command(cwd, "git", args, env ? { env } : {});
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.output.trim();
}
export async function resolveBase(repository: string, baseRef: string): Promise<string> {
  const ref = baseRef.trim();
  if (!ref) throw new Error("Enter a base ref before starting the workflow");
  try {
    return await git(repository, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  } catch {
    throw new Error(`Base ref "${ref}" does not resolve to a commit in ${repository}`);
  }
}

export async function publicationBaseBranch(repository: string, baseRef: string): Promise<string> {
  if (baseRef !== "HEAD") return baseRef.replace(/^origin\//, "");
  const upstream = await command(repository, "git", [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.exitCode === 0) return upstream.output.trim().replace(/^[^/]+\//, "");
  const branch = await git(repository, ["branch", "--show-current"]);
  if (branch) return branch;
  throw new Error("HEAD is detached; enter an explicit base branch before starting the workflow");
}
export async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}
export async function workspace(repository: string, baseCommit: string, root: string, id: string) {
  const branch = `j5/workflow-${hash(id).slice(0, 20)}`;
  const worktree = NodePath.join(root, "worktrees", hash(id));
  await NodeFSP.mkdir(NodePath.join(root, "worktrees"), { recursive: true });
  if (!(await exists(worktree))) {
    const existingBranch = await command(repository, "git", [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (existingBranch.exitCode === 0) {
      if ((await git(repository, ["rev-parse", branch])) !== baseCommit)
        throw new Error("Workflow branch was changed before worktree recovery");
      await git(repository, ["worktree", "add", worktree, branch]);
    } else await git(repository, ["worktree", "add", "-b", branch, worktree, baseCommit]);
  }
  if (
    (await git(worktree, ["rev-parse", "HEAD"])) !== baseCommit ||
    (await git(worktree, ["branch", "--show-current"])) !== branch
  ) {
    throw new Error("Workflow worktree does not match the pinned base and branch");
  }
  return { branch, worktree, baseCommit };
}

/** A temporary index includes additions, deletions, binary bytes and file modes without touching the user's index. */
export async function candidate(worktree: string, baseCommit: string) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: NodePath.join(directory, "index") };
  try {
    await git(worktree, ["read-tree", baseCommit], env);
    await git(worktree, ["-c", "core.filemode=true", "add", "--all", "--", "."], env);
    const tree = await git(worktree, ["write-tree"], env);
    return { tree, codeIdentity: hash({ baseCommit, tree }) };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

export async function durableReceipt(root: string, id: string, output: unknown): Promise<void> {
  const directory = NodePath.join(root, "receipts");
  await NodeFSP.mkdir(directory, { recursive: true });
  const path = NodePath.join(directory, hash(id));
  await NodeFSP.writeFile(`${path}.tmp`, JSON.stringify(output), { flush: true });
  await NodeFSP.rename(`${path}.tmp`, path);
}
export async function receipt(root: string, id: string): Promise<unknown | undefined> {
  const path = NodePath.join(root, "receipts", hash(id));
  if (!(await exists(path))) return undefined;
  return JSON.parse(await NodeFSP.readFile(path, "utf8"));
}
export async function verificationEnvironment(
  worktree: string,
  checks: readonly { executable: string }[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const vite = checks.find((check) => NodePath.basename(check.executable) === "vp");
  if (!vite) return env;
  // Vite+ built-ins such as lint can launch Node from PATH rather than the project runtime.
  const runtime = await command(worktree, vite.executable, ["env", "current", "--json"], { env });
  if (runtime.exitCode !== 0)
    throw new Error(`Cannot resolve verification Node runtime: ${runtime.output}`);
  const node = decodeRuntime(JSON.parse(runtime.output)).node_path;
  if (!NodePath.isAbsolute(node) || !(await exists(node))) {
    throw new Error(`Invalid verification Node runtime: ${node}`);
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...env,
    [pathKey]: [NodePath.dirname(node), env[pathKey]].filter(Boolean).join(NodePath.delimiter),
  };
}

export async function validation(
  worktree: string,
  baseCommit: string,
  checks: readonly {
    executable: string;
    args: readonly string[];
  }[],
  root: string,
  actionId: string,
  signal: AbortSignal,
  correctionApproval: { gateRevision: number; artifactHash: string; actor: string } | null = null,
) {
  const saved = await receipt(root, actionId);
  if (saved !== undefined) return saved;
  if (!checks.length) throw new Error("Required verification commands are missing");
  const env = await verificationEnvironment(worktree, checks);
  const before = await candidate(worktree, baseCommit);
  const marker = NodePath.join(root, "receipts", `${hash(actionId)}.started`);
  await NodeFSP.mkdir(NodePath.join(root, "receipts"), { recursive: true });
  if (await exists(marker))
    throw new Error("Interrupted verification has an unknown result; inspect it before retrying");
  await NodeFSP.writeFile(marker, before.codeIdentity, { flag: "wx", flush: true });
  const results = [];
  for (const check of checks) {
    const result = await command(worktree, check.executable, check.args, { signal, env });
    results.push({ ...check, ...result });
  }
  const after = await candidate(worktree, baseCommit);
  if (before.codeIdentity !== after.codeIdentity)
    throw new Error("Verification changed candidate files");
  const result = {
    ...after,
    effectiveChecksHash: hash(checks),
    correctionApproval,
    checks: results,
    passed: results.every((check) => check.exitCode === 0),
  };
  await durableReceipt(root, actionId, result);
  return result;
}
