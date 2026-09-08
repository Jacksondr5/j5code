// @effect-diagnostics nodeBuiltinImport:off schemaSyncInEffect:off - fixture callbacks validate known scripted artifacts synchronously.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Handoff from "@j5/workflow-contracts/fh";
import type { Run } from "@j5/workflow-contracts";
import { development, latest } from "./development.ts";
import { git, candidate } from "./GitWorkspace.ts";
import { commit, push, draft, type GitHub } from "./Publication.ts";
import { makeCodeAdapters } from "./CodeAdapters.ts";
import { makeStore } from "../../workflow/Store.ts";
import { makeWorker, type Adapter } from "../../workflow/Worker.ts";
import { runWorkflowMigrations } from "../../workflow/Migrations.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-publication-"));
  const repository = NodePath.join(root, "repo");
  const remote = NodePath.join(root, "remote.git");
  await git(root, ["init", "-b", "main", repository]);
  await git(root, ["init", "--bare", remote]);
  await git(repository, ["config", "user.name", "Workflow Fixture"]);
  await git(repository, ["config", "user.email", "workflow@example.test"]);
  await NodeFSP.writeFile(NodePath.join(repository, "README.md"), "Fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  return { root, repository, baseCommit, remote };
}

it.effect(
  "runs the development sequence through failed-check repair, restart, both gates and one draft",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* runWorkflowMigrations();
      const store = yield* makeStore;
      const initial: Run = {
        id: "fh-fixture",
        definitionId: development.id,
        definitionVersion: 1,
        definitionHash: development.hash,
        squadronId: "s",
        projectId: "p",
        repository: f.repository,
        baseCommit: f.baseCommit,
        inputs: { request: "Add a correct value", baseRef: "main", evidence: [] },
        execution: {},
        phase: "workspace",
        revision: 0,
        status: "running",
        cause: null,
        recovery: null,
        gate: null,
        actions: [],
        artifacts: [],
        approvals: [],
        visits: {},
      };
      yield* store.command(
        {
          commandId: "start",
          runId: initial.id,
          initial,
          event: { type: "enter" },
          expectedRevision: 0,
          now: 0,
        },
        development,
      );
      let builds = 0;
      let creates = 0;
      let pr: Awaited<ReturnType<GitHub["find"]>> = null;
      const api: GitHub = {
        find: async () => pr,
        create: async (metadata) => {
          creates++;
          pr = {
            url: "https://example.test/pr/1",
            number: 1,
            draft: true,
            merged: false,
            commit: await git(f.repository, ["rev-parse", metadata.headBranch]),
          };
        },
      };
      const persona: Adapter = {
        recovery: "reconcile",
        interrupt: () => Effect.void,
        reconcile: (action, run) =>
          Effect.promise(async () => {
            let output: unknown;
            if (action.task === "scout")
              output = { summary: "fixture", evidence: ["README.md"], unknowns: [] };
            else if (action.task === "navigator")
              output = {
                summary: "Add value",
                steps: ["Write value.txt"],
                checks: [
                  {
                    executable: "node",
                    args: [
                      "-e",
                      "if(require('fs').readFileSync('value.txt','utf8')!=='correct')process.exit(1)",
                    ],
                  },
                ],
              };
            else if (action.task === "builder") {
              builds++;
              const ws = decodeWorkspace(latest(run, "workspace").content);
              await NodeFSP.writeFile(
                NodePath.join(ws.worktree, "value.txt"),
                builds === 1 ? "incorrect" : "correct",
              );
              output = { summary: "Add verified value", changes: ["value.txt"] };
            } else
              output = {
                verdict: "accept",
                findings: [],
                subjectHash:
                  action.phase === "plan_review"
                    ? latest(run, "plan").hash
                    : decodeValidation(latest(run, "validation").content).codeIdentity,
              };
            return { status: "completed" as const, output };
          }),
      };
      const adapters = { ...makeCodeAdapters(f.root, api), persona };
      yield* makeWorker(store, [development], adapters, "worker-1").drain(1);
      let run = yield* store.get(initial.id);
      assert.equal(run.phase, "plan_approval");
      const approve = (current: Run, commandId: string) =>
        store.command(
          {
            commandId,
            runId: current.id,
            expectedRevision: current.revision,
            now: 2,
            event: {
              type: "decision",
              decision: {
                actor: "fixture-human",
                decision: "approve",
                feedback: "",
                gateRevision: current.gate!.revision,
                artifactHash: current.gate!.artifactHash,
              },
            },
          },
          development,
        );
      yield* approve(run, "plan-approve");
      // Recreate both store and worker: no in-memory execution state is needed.
      const restarted = yield* makeStore;
      yield* makeWorker(restarted, [development], adapters, "worker-2").drain(3);
      run = yield* restarted.get(initial.id);
      assert.equal(run.status, "waiting_approval", run.cause ?? "");
      assert.equal(run.phase, "publication_approval");
      assert.equal(builds, 2);
      assert.equal(creates, 0);
      yield* approve(run, "publish-approve");
      yield* makeWorker(restarted, [development], adapters, "worker-3").drain(4);
      const completed = yield* restarted.get(initial.id);
      assert.equal(completed.status, "completed", completed.cause ?? "");
      assert.equal(creates, 1);
      const ws = decodeWorkspace(latest(completed, "workspace").content);
      const metadata = decodePublication(latest(completed, "metadata").content);
      const committed = yield* Effect.promise(() => commit(ws.worktree, f.baseCommit, metadata));
      yield* Effect.promise(() => push(ws.worktree, f.baseCommit, metadata, committed.commit));
      yield* Effect.promise(() => draft(metadata, committed.commit, api));
      assert.equal(creates, 1);
      assert.equal(
        yield* Effect.promise(() =>
          git(ws.worktree, ["rev-list", "--count", `${f.baseCommit}..HEAD`]),
        ),
        "1",
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(ws.worktree, "unapproved.bin"),
          new Uint8Array([0, 255, 1]),
        ),
      );
      const rejected = yield* Effect.exit(
        Effect.promise(() => commit(ws.worktree, f.baseCommit, metadata)),
      );
      assert.equal(rejected._tag, "Failure");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("includes untracked binary bytes and file modes in code identity without changing the real index", async () => {
  const f = await fixture();
  const before = await candidate(f.repository, f.baseCommit);
  await NodeFSP.writeFile(NodePath.join(f.repository, "binary"), new Uint8Array([0, 255]));
  const added = await candidate(f.repository, f.baseCommit);
  assert.notEqual(added.codeIdentity, before.codeIdentity);
  await NodeFSP.chmod(NodePath.join(f.repository, "binary"), 0o755);
  assert.notEqual((await candidate(f.repository, f.baseCommit)).codeIdentity, added.codeIdentity);
  assert.equal(await git(f.repository, ["diff", "--cached", "--name-only"]), "");
});
