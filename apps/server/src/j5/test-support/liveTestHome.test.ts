// @effect-diagnostics nodeBuiltinImport:off - inspects the generated home with plain file and process calls.
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { buildLiveTestHome } from "./liveTestHome.ts";

it.live(
  "builds a home whose only project is the test repository",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-live-test-home-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const build = buildLiveTestHome({
        root,
        replays: [
          ["multi_turn", "claudeAgent"],
          ["subagent", "codex"],
        ],
      }).pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false })));
      const manifest = yield* build;

      assert.equal(manifest.home, NodePath.join(root, "home"));
      assert.deepEqual(
        JSON.parse(NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8")),
        manifest,
      );

      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(manifest.home, "userdata/statev2.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        assert.deepEqual(
          database.prepare("SELECT project_id, workspace_root FROM projection_projects").all(),
          [{ project_id: manifest.project.id, workspace_root: manifest.testRepo }],
        );
        const threads = database
          .prepare(
            "SELECT title, project_id, created_at, payload_json FROM orchestration_v2_projection_threads ORDER BY created_at",
          )
          .all();
        const titles = threads.map((thread) => String(thread.title));
        assert.include(titles, "Replay fixture: multi_turn (Claude)");
        assert.include(titles, "Replay fixture: subagent (Codex)");
        assert.include(titles, "J5 disposable A2A receiver seed");
        const dayAgo = (yield* Clock.currentTimeMillis) - 24 * 60 * 60 * 1000;
        for (const thread of threads) {
          assert.equal(thread.project_id, manifest.project.id);
          // Replays run on a test clock, which starts in 1970 unless it is set.
          assert.isAbove(Date.parse(String(thread.created_at)), dayAgo);
          // Every path a thread carries stays inside the build.
          for (const [, path] of String(thread.payload_json).matchAll(
            /"(?:cwd|worktreePath)":"([^"]+)"/g,
          )) {
            assert.equal(path, manifest.testRepo);
          }
        }
      } finally {
        database.close();
      }

      const stateDir = NodePath.join(manifest.home, "userdata");
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(`${stateDir}/settings.json`, "utf8")), {
        defaultModelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" },
      });
      assert.deepEqual(NodeFS.readdirSync(`${stateDir}/personas`).toSorted(), [
        "haiku-helper.yaml",
        "luna-helper.yaml",
      ]);

      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", args, { cwd: manifest.testRepo, encoding: "utf8" });
      assert.equal(git("remote", "get-url", "origin").trim(), manifest.testRepoOrigin);
      assert.equal(git("status", "--porcelain", "--branch").trim(), "## main...origin/main");
      assert.equal(git("rev-list", "--count", "HEAD").trim(), "4");
      for (const playbook of manifest.playbooks) {
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(manifest.testRepo, ".j5/playbooks", `${playbook}.yaml`)),
        );
      }
      // The gate times out with no release file; with one it succeeds and removes it,
      // leaving nothing for git to report.
      const hold = (cwd: string) =>
        NodeChildProcess.spawnSync(NodePath.join(cwd, manifest.holdScript), [], {
          cwd,
          env: { ...process.env, HOLD_MAX_SECONDS: "1" },
        }).status;
      assert.equal(hold(manifest.testRepo), 1);
      NodeFS.writeFileSync(manifest.holdReleaseFile, "");
      assert.equal(git("status", "--porcelain").trim(), "");
      // A thread's worktree waits on the main checkout's file, not its own.
      const threadWorktree = NodePath.join(root, "thread-worktree");
      git("worktree", "add", "--quiet", threadWorktree, "-b", "thread");
      assert.equal(hold(threadWorktree), 0);
      assert.isFalse(NodeFS.existsSync(manifest.holdReleaseFile));

      // A second build never writes over the first.
      assert.equal((yield* Effect.exit(build))._tag, "Failure");
    }).pipe(Effect.scoped),
  60_000,
);
