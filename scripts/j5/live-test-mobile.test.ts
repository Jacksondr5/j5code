// @effect-diagnostics nodeBuiltinImport:off - builds throwaway claim directories.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  FINGERPRINT_ENV,
  FINGERPRINT_EVAL,
  MOBILE_PORT_RANGE,
  chooseMobilePorts,
  claimSlot,
  devClientUrl,
  iosPool,
  metroBundles,
  pairingDeepLink,
  releaseSlot,
  shellQuote,
  simulatorsFromSimctl,
} from "./live-test-mobile.ts";
import { LiveTestRefusal, parseCommand } from "./setup-agent-live-test.ts";

const claimsFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-mobile-claims-"));
  const worktree = (name: string) => {
    const path = NodePath.join(root, name);
    NodeFS.mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    directory: NodePath.join(root, "claims"),
    worktree,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

describe("parseCommand --mobile", () => {
  it("sets up a device on a start or rebuild of the default home", () => {
    assert.deepEqual(parseCommand(["--mobile", "ios"]), {
      command: "start",
      mode: "default",
      mobile: "ios",
    });
    assert.deepEqual(parseCommand(["rebuild", "--mobile", "android"]), {
      command: "rebuild",
      mode: "default",
      mobile: "android",
    });
    assert.deepEqual(parseCommand(["mobile-open"]), { command: "mobile-open", mode: "default" });
  });

  it("refuses another platform, another home, or a command that sets nothing up", () => {
    for (const args of [
      ["--mobile"],
      ["--mobile", "windows"],
      ["--mobile", "ios", "--fresh"],
      ["--mobile", "ios", "--peer"],
      ["--mobile", "ios", "--base", "j5/main"],
      ["stop", "--mobile", "ios"],
      ["mobile-open", "--mobile", "ios"],
    ]) {
      assert.throws(() => parseCommand(args), LiveTestRefusal, undefined, args.join(" "));
    }
  });
});

describe("chooseMobilePorts", () => {
  it("keeps one worktree's pair across runs, inside the tailnet's dev range", () => {
    const first = chooseMobilePorts({ worktree: "/w/a", avoid: [], isFree: () => true });
    assert.deepEqual(chooseMobilePorts({ worktree: "/w/a", avoid: [], isFree: () => true }), first);
    assert.strictEqual(first.metroPort, first.serverPort + 1);
    assert.isAtLeast(first.serverPort, MOBILE_PORT_RANGE.first);
    assert.isAtMost(first.metroPort, MOBILE_PORT_RANGE.last);
  });

  it("moves past a pair with a busy or avoided port", () => {
    const first = chooseMobilePorts({ worktree: "/w/a", avoid: [], isFree: () => true });
    const busy = chooseMobilePorts({
      worktree: "/w/a",
      avoid: [],
      isFree: (port) => port !== first.metroPort,
    });
    assert.notStrictEqual(busy.serverPort, first.serverPort);
    const avoided = chooseMobilePorts({
      worktree: "/w/a",
      avoid: [first.serverPort],
      isFree: () => true,
    });
    assert.notStrictEqual(avoided.serverPort, first.serverPort);
  });

  it("refuses when the range is full", () => {
    assert.throws(
      () => chooseMobilePorts({ worktree: "/w/a", avoid: [], isFree: () => false }),
      LiveTestRefusal,
    );
  });
});

describe("claimSlot", () => {
  it("gives each worktree its own slot, the same one again, and refuses past the pool", () => {
    using fixture = claimsFixture();
    const slots = ["j5-tester-1", "j5-tester-2"];
    const [a, b, c] = ["a", "b", "c"].map(fixture.worktree);
    const claim = (worktree: string) =>
      claimSlot({ directory: fixture.directory, platform: "ios", slots, worktree: worktree! });
    assert.strictEqual(claim(a!), "j5-tester-1");
    assert.strictEqual(claim(b!), "j5-tester-2");
    assert.strictEqual(claim(a!), "j5-tester-1");
    assert.throws(() => claim(c!), /All 2 iOS test devices are in use:[\s\S]*j5-tester-1: .*\/a/);
  });

  it("frees a slot only for the worktree that holds it", () => {
    using fixture = claimsFixture();
    const slots = ["j5-tester-1"];
    const [a, b] = ["a", "b"].map(fixture.worktree);
    const input = { directory: fixture.directory, platform: "android", slots } as const;
    claimSlot({ ...input, worktree: a! });
    releaseSlot({ ...input, slot: "j5-tester-1", worktree: b! });
    assert.throws(() => claimSlot({ ...input, worktree: b! }), LiveTestRefusal);
    releaseSlot({ ...input, slot: "j5-tester-1", worktree: a! });
    assert.strictEqual(claimSlot({ ...input, worktree: b! }), "j5-tester-1");
  });

  it("says how to clear a claim whose worktree is gone", () => {
    using fixture = claimsFixture();
    const input = { directory: fixture.directory, platform: "android", slots: ["s"] } as const;
    const gone = fixture.worktree("gone");
    claimSlot({ ...input, worktree: gone });
    NodeFS.rmSync(gone, { recursive: true });
    assert.throws(
      () => claimSlot({ ...input, worktree: fixture.worktree("next") }),
      /that worktree is gone: rm -r .*android-s/,
    );
  });
});

describe("iosPool", () => {
  it("takes the available j5-tester Simulators in number order, with their state", () => {
    const simulators = simulatorsFromSimctl(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            { name: "j5-tester-10", udid: "U10", state: "Shutdown", isAvailable: true },
            { name: "j5-tester-2", udid: "U2", state: "Booted", isAvailable: true },
            { name: "iPhone 17 Pro", udid: "P", state: "Booted", isAvailable: true },
            { name: "j5-tester-3", udid: "U3", state: "Shutdown", isAvailable: false },
          ],
        },
      }),
    );
    assert.deepEqual(
      iosPool(simulators).map((s) => [s.name, s.booted]),
      [
        ["j5-tester-2", true],
        ["j5-tester-10", false],
      ],
    );
  });
});

describe("links", () => {
  it("opens the dev client on the address each device reaches this machine by", () => {
    const ios = new URL(devClientUrl("ios", 7001));
    assert.strictEqual(ios.protocol, "j5code-dev:");
    assert.strictEqual(ios.searchParams.get("url"), "http://127.0.0.1:7001");
    assert.strictEqual(
      new URL(devClientUrl("android", 7001)).searchParams.get("url"),
      "http://10.0.2.2:7001",
    );
  });

  it("moves the pairing token onto the backend origin the device reaches", () => {
    const link = new URL(
      pairingDeepLink({
        platform: "android",
        serverPort: 7000,
        pairingUrl: "http://localhost:6741/pair#token=ABC123",
      }),
    );
    assert.strictEqual(link.host, "connections");
    assert.strictEqual(
      link.searchParams.get("pairingUrl"),
      "http://10.0.2.2:7000/pair#token=ABC123",
    );
    assert.strictEqual(link.searchParams.get("autoConnect"), "1");
  });
});

describe("metroBundles", () => {
  it("counts served and failed bundles through the log's colours", () => {
    const log = [
      "\u001B[32mAndroid Bundled\u001B[39m 4038ms apps/mobile/index.ts (4587 modules)",
      "iOS Bundled 812ms apps/mobile/src/lib/uuid.ts (911 modules)",
      "iOS Bundling failed 30ms apps/mobile/index.ts",
    ].join("\n");
    assert.deepEqual(metroBundles(log), { served: 2, failed: 1 });
  });
});

describe("shellQuote", () => {
  it("keeps a URL with & and ' as one word", () => {
    assert.strictEqual(shellQuote("a&b'c"), `'a&b'\\''c'`);
  });
});

describe("fingerprint", () => {
  it("is computed as scripts/mobile-native-client.ts computes it, so the cached client is found", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "..", "mobile-native-client.ts"),
      "utf8",
    );
    assert.include(source, FINGERPRINT_EVAL);
    for (const [key, value] of Object.entries(FINGERPRINT_ENV)) {
      assert.include(source, `${key}: "${value}"`);
    }
  });
});
