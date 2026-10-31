// @effect-diagnostics nodeBuiltinImport:off - runs the iOS build script's lock in a throwaway home.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { iosBuildScript, parseMobileBuild } from "./live-test-mobile-build.ts";
import { LiveTestRefusal } from "./setup-agent-live-test.ts";

describe("parseMobileBuild", () => {
  it("takes one platform and nothing else", () => {
    assert.strictEqual(parseMobileBuild(["ios"]), "ios");
    assert.strictEqual(parseMobileBuild(["android"]), "android");
    for (const args of [[], ["windows"], ["ios", "android"]]) {
      assert.throws(() => parseMobileBuild(args), LiveTestRefusal);
    }
  });
});

describe("iosBuildScript", () => {
  // Only the lock is exercised: everything after it needs the iOS host's checkout and toolchain.
  const runUntilCheckout = (home: string) =>
    NodeChildProcess.spawnSync(
      "sh",
      [
        "-c",
        iosBuildScript({ commit: "abc123", owner: "/w/it's-mine" }).split(
          "cd j5-mobile-rig/checkout",
        )[0]!,
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );

  it("stops at a signal instead of going on without the lock", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-build-"));
    try {
      const [prelude] = iosBuildScript({ commit: "abc123", owner: "/w/a" }).split(
        "cd j5-mobile-rig/checkout",
      );
      // sh, like the iOS host's zsh, resumes after a trap that does not exit.
      const run = NodeChildProcess.spawnSync(
        "sh",
        ["-c", `${prelude}kill -TERM $$\necho CONTINUED\n`],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      assert.notStrictEqual(run.status, 0);
      assert.notInclude(run.stdout, "CONTINUED");
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "j5-mobile-rig", "build.lock")));
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses while another build holds the lock, naming its owner, and releases its own", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-build-"));
    try {
      NodeFS.mkdirSync(NodePath.join(home, "j5-mobile-rig", "build.lock"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, "j5-mobile-rig", "build.lock", "owner"),
        "/w/other\n",
      );
      const held = runUntilCheckout(home);
      assert.strictEqual(held.status, 75);
      assert.include(held.stderr, "/w/other");

      NodeFS.rmSync(NodePath.join(home, "j5-mobile-rig", "build.lock"), { recursive: true });
      const free = runUntilCheckout(home);
      assert.strictEqual(free.status, 0, free.stderr);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "j5-mobile-rig", "build.lock")));
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
