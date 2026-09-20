import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import * as ProcessRunner from "../../processRunner.ts";
import * as Installer from "./skillCatalogInstaller.ts";
import { createSkillCatalogTool } from "./skillCatalogTool.ts";

vi.mock("./skillCatalogInstaller.ts", async (original) => ({
  ...(await original<typeof Installer>()),
}));
beforeEach(() => vi.stubEnv("CLAUDE_CONFIG_DIR", ""));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type RunInput = ProcessRunner.ProcessRunInput;
const output = (stdout = "", code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-catalog-tool-" });
  const catalogDir = path.join(root, "catalog");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const calls: RunInput[] = [];
  const writeCatalog = (dir: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(dir, "skills", "explain"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "catalog.yaml"),
        "groups:\n  core:\n    description: Core skills\n    skills: [explain]\n",
      );
      yield* fs.writeFileString(
        path.join(dir, "skills", "explain", "SKILL.md"),
        "---\ndescription: Explain clearly\n---\n",
      );
    });
  yield* writeCatalog(catalogDir);
  const runner = (
    handler?: (
      input: RunInput,
    ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  ) =>
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          assert.equal(input.command, "git");
          calls.push(input);
          if (handler) return yield* handler(input);
          if (input.args[0] === "clone") {
            yield* writeCatalog(input.args[2]!).pipe(Effect.orDie);
            return output();
          }
          return output(
            "",
            128,
            "fatal: not a git repository (or any of the parent directories): .git",
          );
        }),
    });
  const tool = (processRunner = runner()) =>
    createSkillCatalogTool({ stateDir, homeDir, fs, path, processRunner });
  return { fs, path, root, catalogDir, homeDir, stateDir, calls, writeCatalog, runner, tool };
});

const test = <E>(
  name: string,
  run: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | import("effect/Scope").Scope>,
) => {
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* run(yield* fixture);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
};

describe("skill catalog tool", () => {
  test("clones content on first use, reuses it, and preserves A → B → A checkouts", (f) =>
    Effect.gen(function* () {
      const tool = f.tool();
      const a = "https://example.com/a.git";
      const b = "https://example.com/b.git";
      const first = yield* tool.status({ source: a });
      assert.equal(f.path.basename(first.catalogDir), "catalog");
      assert.equal(first.groups[0]?.skills[0]?.description, "Explain clearly");
      const second = yield* tool.status({ source: b });
      const again = yield* tool.status({ source: a });
      assert.equal(again.catalogDir, first.catalogDir);
      assert.notEqual(second.catalogDir, first.catalogDir);
      assert.equal(f.calls.filter((call) => call.args[0] === "clone").length, 2);
      assert.isTrue(yield* f.fs.exists(first.catalogDir));
      assert.isTrue(yield* f.fs.exists(second.catalogDir));
      assert.isFalse(yield* f.fs.exists(f.path.join(first.catalogDir, "installer")));
    }));

  test("failed clones are unpublished and retryable", (f) =>
    Effect.gen(function* () {
      let attempts = 0;
      const tool = f.tool(
        f.runner((input) =>
          Effect.gen(function* () {
            if (input.args[0] !== "clone") return output("", 128, "not a git repository");
            yield* f.writeCatalog(input.args[2]!).pipe(Effect.orDie);
            return ++attempts === 1 ? output("", 128, "clone failed") : output();
          }),
        ),
      );
      const source = "https://example.com/retry.git";
      const failed = yield* Effect.flip(tool.status({ source }));
      assert.match(failed.message, /retryable; no checkout was published/);
      const records = yield* f.fs.readDirectory(f.path.join(f.stateDir, "skill-catalogs"));
      assert.deepEqual(
        yield* f.fs.readDirectory(f.path.join(f.stateDir, "skill-catalogs", records[0]!)),
        [],
      );
      yield* tool.status({ source });
      assert.equal(attempts, 2);
    }));

  test("retains Git spawn and timeout diagnostics", (f) =>
    Effect.gen(function* () {
      for (const cause of [
        new ProcessRunner.ProcessSpawnError({
          command: "git",
          argumentCount: 3,
          cause: new Error("spawn git ENOENT"),
        }),
        new ProcessRunner.ProcessTimeoutError({
          command: "git",
          argumentCount: 3,
          timeoutMs: 300_000,
        }),
      ]) {
        const tool = f.tool(f.runner(() => Effect.fail(cause)));
        const failure = yield* Effect.flip(
          tool.status({ source: "https://example.com/unavailable.git" }),
        );
        assert.match(
          failure.message,
          /could not start git.*is Git installed|timed out after five minutes/,
        );
        assert.match(failure.message, /no checkout was published/);
      }
    }));

  test("rejects blank/relative sources and missing catalogs", (f) =>
    Effect.gen(function* () {
      const tool = f.tool();
      for (const source of ["", "  ", "relative/path", "owner/repo"]) {
        const failure = yield* Effect.flip(tool.status({ source }));
        assert.equal(failure._tag, "SkillCatalogError");
      }
      assert.deepEqual(f.calls, []);
      const source = f.path.join(f.root, "missing");
      assert.equal(
        (yield* Effect.flip(tool.status({ source }))).message,
        `No catalog.yaml in ${source}.`,
      );
    }));

  test("reports metadata, saved-group warnings, and a genuine non-repository", (f) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Installer.saveState(f.homeDir, { folder: f.catalogDir, groups: ["gone"], links: [] }),
      );
      const result = yield* f.tool().status({ source: f.catalogDir });
      assert.deepEqual(result.groups, [
        {
          name: "core",
          description: "Core skills",
          depends: [],
          skills: [{ name: "explain", description: "Explain clearly" }],
        },
      ]);
      assert.deepEqual(result.selectedGroups, ["gone"]);
      assert.deepEqual(result.warnings, ['Saved group "gone" is not in the catalog.']);
      assert.deepEqual(result.git, { upstream: null, dirty: false });
      assert.deepEqual(result.targets, [
        f.path.join(f.homeDir, ".agents", "skills"),
        f.path.join(f.homeDir, ".claude", "skills"),
      ]);
    }));

  test("warns on Git repository/status failures and preserves dirty status without upstream", (f) =>
    Effect.gen(function* () {
      for (const phase of ["root", "status", "upstream"]) {
        const tool = f.tool(
          f.runner((input) =>
            Effect.succeed(
              input.args.includes("--show-toplevel")
                ? phase === "root"
                  ? output("", 128, "bad config")
                  : output(f.catalogDir)
                : input.args[0] === "status"
                  ? phase === "status"
                    ? output("", 128, "status denied")
                    : output(" M catalog.yaml\n")
                  : output("", 128, "no upstream"),
            ),
          ),
        );
        const result = yield* tool.status({ source: f.catalogDir });
        assert.deepEqual(result.git, { upstream: null, dirty: phase === "upstream" });
        assert.equal(result.warnings.length, phase === "upstream" ? 0 : 1);
      }
      const missingGit = f.tool(
        f.runner(() =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "git",
              argumentCount: 1,
              cause: "missing",
            }),
          ),
        ),
      );
      assert.match(
        (yield* missingGit.status({ source: f.catalogDir })).warnings[0]!,
        /could not start git/,
      );
    }));

  test("applies and removes real links without invoking processes", (f) =>
    Effect.gen(function* () {
      const tool = f.tool();
      const input = { source: f.catalogDir, groups: ["core"] };
      assert.equal((yield* tool.apply(input)).installed, 2);
      assert.match(
        yield* f.fs.readFileString(
          f.path.join(f.homeDir, ".agents", "skills", "explain", "SKILL.md"),
        ),
        /Explain clearly/,
      );
      assert.equal((yield* tool.apply(input)).unchanged, 2);
      assert.equal((yield* tool.apply({ ...input, groups: [] })).removed, 2);
      assert.deepEqual(f.calls, []);
      const unknown = yield* Effect.flip(tool.apply({ ...input, groups: ["unknown"] }));
      assert.equal(unknown.message, "Unknown group: unknown");
    }));

  test("malformed ownership fails before uninstall and stays intact", (f) =>
    Effect.gen(function* () {
      const tool = f.tool();
      yield* tool.apply({ source: f.catalogDir, groups: ["core"] });
      const stateFile = Installer.stateFilePath(f.homeDir);
      yield* f.fs.writeFileString(stateFile, "{broken");
      const failure = yield* Effect.flip(tool.apply({ source: f.catalogDir, groups: [] }));
      assert.match(failure.message, /Cannot read state:/);
      assert.equal(yield* f.fs.readFileString(stateFile), "{broken");
      assert.isTrue(
        yield* f.fs.exists(f.path.join(f.homeDir, ".agents", "skills", "explain", "SKILL.md")),
      );
    }));

  test("keeps partial apply results on typed tool errors", (f) =>
    Effect.gen(function* () {
      const original = Installer.runApply;
      vi.spyOn(Installer, "runApply").mockImplementationOnce((input) =>
        original(input, {
          verifyLinks: async () => {
            throw new Error("verification denied");
          },
        }),
      );
      const failure = yield* Effect.flip(
        f.tool().apply({ source: f.catalogDir, groups: ["core"] }),
      );
      assert.equal(failure._tag, "SkillCatalogError");
      assert.equal(failure.result?.installed, 2);
      assert.equal(failure.result?.failed.length, 1);
    }));

  test("refuses dirty/non-repository/no-upstream updates, otherwise fetches then fast-forwards", (f) =>
    Effect.gen(function* () {
      for (const mode of ["non-repo", "dirty", "no-upstream", "ok", "fetch-fails", "pull-fails"]) {
        f.calls.length = 0;
        const tool = f.tool(
          f.runner((input) =>
            Effect.succeed(
              input.args[0] === "status"
                ? output(mode === "dirty" ? " M catalog.yaml" : "", mode === "non-repo" ? 128 : 0)
                : input.args[0] === "rev-parse"
                  ? output("origin/main", mode === "no-upstream" ? 128 : 0)
                  : mode === `${input.args[0]}-fails`
                    ? output("", 1, "error ".repeat(500))
                    : output(),
            ),
          ),
        );
        if (mode === "ok") {
          assert.deepEqual(yield* tool.update({ source: f.catalogDir }), {
            upstream: "origin/main",
          });
          assert.deepEqual(
            f.calls.map((call) => call.args),
            [
              ["status", "--porcelain"],
              ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
              ["fetch"],
              ["pull", "--ff-only"],
            ],
          );
        } else {
          const failure = yield* Effect.flip(tool.update({ source: f.catalogDir }));
          assert.match(
            failure.message,
            mode === "non-repo"
              ? /Not a git checkout/
              : mode === "dirty"
                ? /Refusing to update: local changes/
                : mode === "no-upstream"
                  ? /Refusing to update: no upstream/
                  : /failed.*Stderr:/,
          );
          assert.isBelow(failure.message.length, 2200);
          assert.equal(
            f.calls.length,
            mode === "non-repo" || mode === "dirty"
              ? 1
              : mode === "no-upstream"
                ? 2
                : mode === "fetch-fails"
                  ? 3
                  : 4,
          );
        }
      }
    }));

  test("two tool instances share the serialization boundary", (f) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      const runner = f.runner(() =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(gate);
          return output("", 128, "not a git repository");
        }),
      );
      const first = yield* Effect.forkScoped(f.tool(runner).status({ source: f.catalogDir }));
      yield* Deferred.await(entered);
      const second = yield* Effect.forkScoped(f.tool(runner).status({ source: f.catalogDir }));
      assert.equal(calls, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(calls, 2);
    }));

  test("interrupted apply retains the permit until persistence and refresh waits for it", (f) =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const events: string[] = [];
      const originalApply = Installer.runApply;
      const originalLoad = Installer.loadState;
      vi.spyOn(Installer, "loadState").mockImplementation((home) => {
        events.push("read state");
        return originalLoad(home);
      });
      vi.spyOn(Installer, "runApply").mockImplementationOnce(async (input) => {
        events.push("started");
        entered.resolve();
        await gate.promise;
        const result = await originalApply(input);
        events.push("persisted");
        return result;
      });
      yield* Effect.gen(function* () {
        const first = yield* Effect.forkScoped(
          f
            .tool()
            .apply({ source: f.catalogDir, groups: ["core"] })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  events.push("refreshed");
                }),
              ),
            ),
        );
        yield* Effect.promise(() => entered.promise);
        const interruption = yield* Effect.forkScoped(Fiber.interrupt(first));
        const second = yield* Effect.forkScoped(
          f.tool().apply({ source: f.catalogDir, groups: [] }),
        );
        yield* Effect.yieldNow;
        const beforeRelease = [...events];
        gate.resolve();
        yield* Fiber.join(interruption);
        const result = yield* Fiber.join(second);
        assert.deepEqual(beforeRelease, ["read state", "started"]);
        assert.equal(result.removed, 2);
        assert.isAbove(events.indexOf("refreshed"), events.indexOf("persisted"));
        assert.isAbove(events.lastIndexOf("read state"), events.indexOf("persisted"));
      }).pipe(Effect.ensuring(Effect.sync(() => gate.resolve())));
    }));
});
