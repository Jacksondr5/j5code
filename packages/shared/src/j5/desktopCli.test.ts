// @effect-diagnostics nodeBuiltinImport:off - Runs the generated shell script for real.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { HostProcessPlatform } from "../hostProcess.ts";
import { desktopCliScript } from "./desktopCli.ts";

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("desktop j5 script", () => {
  it("runs the app in Node mode with every argument, and says so when the app is gone", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-desktop-script-"));
    try {
      // App bundles have spaces in their paths; quotes must survive too.
      const appDir = NodePath.join(root, "J5 Code's.app");
      NodeFS.mkdirSync(appDir);
      const executable = NodePath.join(appDir, "J5 Code");
      NodeFS.writeFileSync(executable, '#!/bin/sh\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$@"\n', {
        mode: 0o755,
      });
      const command = NodePath.join(root, "j5");
      NodeFS.writeFileSync(
        command,
        desktopCliScript({ executable, entry: `${appDir}/app.asar/bin.mjs` }),
        { mode: 0o755 },
      );

      expect(
        NodeChildProcess.execFileSync(command, ["a2a", "send", "two words"], { encoding: "utf8" }),
      ).toBe(`1|${appDir}/app.asar/bin.mjs|a2a|send|two words|`);

      NodeFS.rmSync(appDir, { recursive: true });
      const gone = NodeChildProcess.spawnSync(command, ["--version"], { encoding: "utf8" });
      expect(gone.status).toBe(127);
      expect(gone.stderr).toBe(
        `j5: the J5 Code app is no longer at ${executable}. Open the app once to repair this command.\n`,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
