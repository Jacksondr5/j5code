// @effect-diagnostics nodeBuiltinImport:off - builds throwaway directory layouts to exercise the path guards.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  classifyServer,
  LiveTestRefusal,
  liveTestEnvironment,
  parseCommand,
  readServerLog,
  resolveLiveTestPaths,
  startRefusal,
  type ServerLogFacts,
} from "./setup-agent-live-test.ts";

/** A fake machine: a home with a live `.j5code`, a main checkout, and a linked worktree below the live home. */
function makeLayout() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-script-")),
  );
  const homeDirectory = NodePath.join(base, "home");
  const liveHome = NodePath.join(homeDirectory, ".j5code");
  const mainCheckout = NodePath.join(base, "main");
  const worktree = NodePath.join(liveHome, "worktrees", "project", "feature");
  NodeFS.mkdirSync(NodePath.join(liveHome, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(mainCheckout, ".git"), { recursive: true });
  NodeFS.mkdirSync(worktree, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(worktree, ".git"),
    `gitdir: ${mainCheckout}/.git/worktrees/feature\n`,
  );
  return { base, homeDirectory, liveHome, mainCheckout, worktree };
}

const refusal = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (cause) {
    assert.instanceOf(cause, LiveTestRefusal);
    return (cause as LiveTestRefusal).message;
  }
  return assert.fail("expected a refusal");
};

describe("resolveLiveTestPaths", () => {
  it("puts the test state in a linked worktree's own .j5code, even below the live home", async () => {
    const layout = makeLayout();
    const paths = await resolveLiveTestPaths({
      checkout: layout.worktree,
      homeDirectory: layout.homeDirectory,
      environment: { J5CODE_HOME: layout.liveHome },
    });
    assert.equal(paths.root, NodePath.join(layout.worktree, ".j5code", "live-test"));
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses the main checkout and a directory that is no checkout", async () => {
    const layout = makeLayout();
    for (const checkout of [layout.mainCheckout, layout.base]) {
      assert.include(
        await refusal(
          resolveLiveTestPaths({ checkout, homeDirectory: layout.homeDirectory, environment: {} }),
        ),
        "not a linked git worktree",
      );
    }
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses a .j5code that links out of the worktree", async () => {
    const layout = makeLayout();
    NodeFS.symlinkSync(layout.liveHome, NodePath.join(layout.worktree, ".j5code"));
    assert.include(
      await refusal(
        resolveLiveTestPaths({
          checkout: layout.worktree,
          homeDirectory: layout.homeDirectory,
          environment: {},
        }),
      ),
      "outside this worktree's .j5code",
    );
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses when the worktree's .j5code is the live home", async () => {
    const layout = makeLayout();
    const environment = { J5CODE_HOME: NodePath.join(layout.worktree, ".j5code") };
    assert.include(
      await refusal(
        resolveLiveTestPaths({
          checkout: layout.worktree,
          homeDirectory: layout.homeDirectory,
          environment,
        }),
      ),
      "is the live home",
    );
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });
});

describe("resolveLiveTestPaths after a build", () => {
  const resolve = (layout: ReturnType<typeof makeLayout>) =>
    resolveLiveTestPaths({
      checkout: layout.worktree,
      homeDirectory: layout.homeDirectory,
      environment: { J5CODE_HOME: layout.liveHome },
    });

  it("refuses a home or repository that has become a link out of the build", async () => {
    for (const [name, target] of [
      ["home", (layout: ReturnType<typeof makeLayout>) => layout.liveHome],
      ["test-repo", (layout: ReturnType<typeof makeLayout>) => layout.mainCheckout],
    ] as const) {
      const layout = makeLayout();
      const root = NodePath.join(layout.worktree, ".j5code", "live-test");
      NodeFS.mkdirSync(root, { recursive: true });
      NodeFS.symlinkSync(target(layout), NodePath.join(root, name));
      assert.include(await refusal(resolve(layout)), `outside ${root}`);
      NodeFS.rmSync(layout.base, { recursive: true, force: true });
    }
  });

  it("derives the home from the worktree, whatever a manifest might say", async () => {
    const layout = makeLayout();
    const root = NodePath.join(layout.worktree, ".j5code", "live-test");
    NodeFS.mkdirSync(NodePath.join(root, "home"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "manifest.json"),
      JSON.stringify({ home: layout.liveHome, testRepo: layout.mainCheckout }),
    );
    const paths = await resolve(layout);
    assert.equal(paths.home, NodePath.join(root, "home"));
    assert.equal(paths.testRepo, NodePath.join(root, "test-repo"));
    NodeFS.rmSync(layout.base, { recursive: true, force: true });
  });

  it("refuses a worktree whose path would break the commands it prints", async () => {
    for (const name of ["with space", "semi;colon", "dollar$(x)"]) {
      const layout = makeLayout();
      const worktree = NodePath.join(NodePath.dirname(layout.worktree), name);
      NodeFS.renameSync(layout.worktree, worktree);
      assert.include(
        await refusal(resolve({ ...layout, worktree })),
        "contains a space or a shell character",
      );
      NodeFS.rmSync(layout.base, { recursive: true, force: true });
    }
  });
});

describe("startRefusal", () => {
  const facts: ServerLogFacts = {
    serverPort: 15634,
    webPort: 7594,
    baseDir: "/w/.j5code/live-test/home",
    pairingUrl: undefined,
    recovered: false,
  };
  const input = { facts, home: "/w/.j5code/live-test/home", inheritedPort: "5773" };

  it("lets a server on the test home and its own port continue, before and after it reports", () => {
    assert.isUndefined(startRefusal(input));
    assert.isUndefined(
      startRefusal({ ...input, facts: { ...facts, serverPort: undefined, baseDir: undefined } }),
    );
  });

  it("abandons a server on another home", () => {
    assert.include(
      startRefusal({ ...input, facts: { ...facts, baseDir: "/w/.j5code" } }) ?? "",
      "not the test home",
    );
  });

  it("abandons a server on the live port or the port the shell inherited", () => {
    assert.include(
      startRefusal({ ...input, inheritedPort: undefined, facts: { ...facts, serverPort: 5773 } }) ??
        "",
      "live server's port",
    );
    assert.include(startRefusal({ ...input, inheritedPort: "15634" }) ?? "", "live server's port");
  });
});

describe("liveTestEnvironment", () => {
  it("drops what the live server exports and stops the dev server adopting its cwd", () => {
    const environment = liveTestEnvironment(
      {
        T3CODE_PORT: "5773",
        T3CODE_HOST: "127.0.0.1",
        J5CODE_HOME: "/home/dev/.j5code",
        J5CODE_SERVER_NAME: "live",
        PATH: "/usr/bin",
        KEEP: "1",
      },
      "/work/tree",
    );
    assert.deepEqual(environment, {
      KEEP: "1",
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      PATH: `/work/tree/node_modules/.bin${NodePath.delimiter}/usr/bin`,
    });
  });
});

describe("readServerLog", () => {
  it("reads the ports, the home and the newest pairing URL through the logger's colours", () => {
    const log = [
      "\u001B[32m[dev-runner] mode=dev source=worktree /w serverPort=15634 webPort=7594 baseDir=/w/.j5code/live-test/home\u001B[0m",
      "  pairingUrl: http://localhost:7594/pair#token=OLD",
      "[22:02:53.552] INFO (#4139): V2 orchestration recovery completed",
      "  \u001B[1mpairingUrl\u001B[0m: http://localhost:7594/pair#token=NEW",
    ].join("\n");
    assert.deepEqual(readServerLog(log), {
      serverPort: 15634,
      webPort: 7594,
      baseDir: "/w/.j5code/live-test/home",
      pairingUrl: "http://localhost:7594/pair#token=NEW",
      recovered: true,
    });
    assert.deepEqual(readServerLog("starting"), {
      serverPort: undefined,
      webPort: undefined,
      baseDir: undefined,
      pairingUrl: undefined,
      recovered: false,
    });
  });
});

describe("classifyServer", () => {
  const facts: ServerLogFacts = {
    serverPort: 15634,
    webPort: 7594,
    baseDir: "/w/.j5code/live-test/home",
    pairingUrl: "http://localhost:7594/pair#token=T",
    recovered: true,
  };
  const ours = {
    worktree: "/w",
    group: 100,
    facts,
    groupMembers: () => [100, 101],
    listenerOn: () => 101,
    processGroupOf: () => 100,
    cwdOf: () => "/w/apps/server",
  };

  it("is running only when the port's listener is in the recorded group and inside the worktree", () => {
    assert.equal(classifyServer(ours).kind, "running");
  });

  it("is stopped with no record, or once the recorded group is empty", () => {
    assert.equal(classifyServer({ ...ours, group: undefined }).kind, "stopped");
    assert.equal(classifyServer({ ...ours, groupMembers: () => [] }).kind, "stopped");
  });

  it("never treats a live group as ours when the port check fails", () => {
    for (const other of [
      { facts: { ...facts, serverPort: undefined } },
      { listenerOn: () => undefined },
      // The port now belongs to another server, such as the live one.
      { processGroupOf: () => 999 },
      { cwdOf: () => "/somewhere/else" },
      // A sibling directory that shares the worktree's name as a prefix.
      { cwdOf: () => "/w-other/apps/server" },
      { cwdOf: () => undefined },
    ]) {
      assert.equal(classifyServer({ ...ours, ...other }).kind, "unverified");
    }
  });
});

describe("parseCommand", () => {
  it("defaults to start and refuses anything it does not know", () => {
    assert.equal(parseCommand([]), "start");
    assert.equal(parseCommand(["restart"]), "restart");
    assert.throws(() => parseCommand(["--fresh"]), LiveTestRefusal);
    assert.throws(() => parseCommand(["stop", "now"]), LiveTestRefusal);
  });
});
