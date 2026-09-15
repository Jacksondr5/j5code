// @effect-diagnostics nodeBuiltinImport:off - real process contention tests use Node IPC and disposable filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
// oxlint-disable-next-line t3code/namespace-node-imports -- Node/Bun typings expose once only as a named import.
import { once } from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

const roots: string[] = [];
const children: ReturnType<typeof NodeChildProcess.fork>[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function statePath() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-server-ownership-"));
  roots.push(root);
  return NodePath.join(root, "server-runtime.json");
}
async function contender(path: string) {
  const child = NodeChildProcess.fork(
    new URL("./fixtures/serverOwnershipChild.ts", import.meta.url),
    [path],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  children.push(child);
  expect((await once(child, "message"))[0]).toBe("ready");
  return child;
}
async function command(child: ReturnType<typeof NodeChildProcess.fork>, message: string) {
  const reply = once(child, "message");
  child.send(message);
  return (await reply)[0];
}

it("grants exactly one concurrent claim before PID publication and keeps directories independent", async () => {
  const path = await statePath();
  const contenders = await Promise.all([contender(path), contender(path)]);
  const replies = await Promise.all(contenders.map((child) => command(child, "start")));
  expect(replies.filter((reply) => reply === "acquired")).toHaveLength(1);
  expect(replies.find((reply) => reply !== "acquired")).toMatchObject({
    tag: "StateDirectoryAlreadyInUseError",
    message: expect.stringContaining("PID not yet available"),
  });
  const independent = await contender(await statePath());
  expect(await command(independent, "start")).toBe("acquired");
  expect(await command(independent, "stop")).toBe("released");
});

it.each(["stop", "fail", "SIGKILL"])(
  "releases ownership after %s for a replacement",
  async (action) => {
    const path = await statePath();
    const owner = await contender(path);
    expect(await command(owner, "start")).toBe("acquired");
    const exited = once(owner, "exit");
    if (action === "SIGKILL") owner.kill("SIGKILL");
    else {
      const reply = await command(owner, action);
      expect(reply).toEqual(
        action === "stop" ? "released" : { tag: "StartupFailure", message: "startup failed" },
      );
    }
    await exited;
    await NodeFSP.access(NodePath.join(path, "..", "server-ownership.sqlite"));
    const replacement = await contender(path);
    expect(await command(replacement, "start")).toBe("acquired");
    expect(await command(replacement, "stop")).toBe("released");
  },
);
