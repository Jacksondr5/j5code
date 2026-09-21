// @effect-diagnostics nodeBuiltinImport:off - isolated Git integration fixtures.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Run } from "@j5/playbook-contracts";
import { compileYamlPlaybook } from "./Yaml.ts";
import { makeCodeAdapters } from "./fh/CodeAdapters.ts";
import { git } from "./fh/GitWorkspace.ts";
import type { GitHub } from "./fh/Publication.ts";
import { parse, stringify } from "yaml";
import type { YamlPlaybook } from "./Yaml.ts";
import { decide } from "../playbook/decider.ts";
import { testExecution } from "../playbook/testFixtures.ts";

it.effect.each([false, true])(
  "publishes custom phases with exact approval and idempotent retries (review loop: %s)",
  (reviewLoop) =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        NodeFSP.readFile(
          new URL(
            "../../../../../.agents/skills/j5-new-playbook/examples/publication.yaml",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const authored = parse(source) as YamlPlaybook;
      const definition = compileYamlPlaybook(
        reviewLoop
          ? stringify({
              ...authored,
              phases: [
                ...authored.phases.map((phase) => ({
                  ...phase,
                  visitLimit: 3,
                  ...(phase.id === "development"
                    ? {
                        evidence: ["scout", "plan", "herald"],
                        approvals: ["pr-approval", "feedback"],
                      }
                    : {}),
                  ...(phase.id === "create-pr"
                    ? { transitions: { pass: "collect-feedback" } }
                    : {}),
                })),
                {
                  id: "collect-feedback",
                  kind: "code",
                  visitLimit: 3,
                  tasks: [{ id: "collect", operation: "feedback" }],
                  transitions: { pass: "herald" },
                },
                {
                  id: "herald",
                  kind: "agent",
                  visitLimit: 3,
                  evidence: ["create-pr", "collect-feedback"],
                  tasks: [
                    {
                      id: "feedback",
                      agent: "scout",
                      instructions: "Collect PR feedback.",
                      output: "report",
                    },
                  ],
                  transitions: { completed: "feedback" },
                },
                {
                  id: "feedback",
                  kind: "gate",
                  visitLimit: 3,
                  evidence: ["herald"],
                  transitions: { approve: "$complete", request_changes: "development" },
                },
              ],
            })
          : source,
      );
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "custom-publication-")),
      );
      try {
        const repository = NodePath.join(root, "repo");
        const remote = NodePath.join(root, "remote.git");
        yield* Effect.promise(() => git(root, ["init", "-b", "main", repository]));
        yield* Effect.promise(() => git(root, ["init", "--bare", remote]));
        yield* Effect.promise(() => git(repository, ["config", "user.name", "Fixture"]));
        yield* Effect.promise(() =>
          git(repository, ["config", "user.email", "fixture@example.test"]),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(repository, "README.md"), "initial\n"),
        );
        yield* Effect.promise(() => git(repository, ["add", "."]));
        yield* Effect.promise(() => git(repository, ["commit", "-m", "initial"]));
        yield* Effect.promise(() => git(repository, ["remote", "add", "origin", remote]));
        const baseCommit = yield* Effect.promise(() => git(repository, ["rev-parse", "HEAD"]));
        let run: Run = {
          id: "custom-test",
          definitionId: definition.id,
          definitionVersion: definition.version,
          definitionHash: definition.hash,
          squadronId: "squadron",
          projectId: "project",
          repository,
          baseCommit,
          inputs: { request: "fix", baseRef: "main", evidence: [] },
          execution: {
            ...testExecution,
            personas: {
              scout: testExecution.personas.scout,
              planner: testExecution.personas.navigator,
              developer: testExecution.personas.builder,
            },
          },
          phase: definition.initial,
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
        let pr: Awaited<ReturnType<GitHub["find"]>> = null;
        let creates = 0;
        const updates: string[] = [];
        const api: GitHub = {
          find: async (metadata) =>
            pr
              ? {
                  ...pr,
                  commit: (
                    await git(repository, [
                      "ls-remote",
                      "origin",
                      `refs/heads/${metadata.headBranch}`,
                    ])
                  ).split(/\s/)[0]!,
                }
              : null,
          update: async (metadata) => {
            updates.push(metadata.title);
          },
          create: async (metadata) => {
            creates++;
            assert.equal(metadata.title, "Edited title");
            assert.equal(metadata.body, "Edited body");
            pr = {
              url: "https://example.test/pr/1",
              number: 1,
              draft: true,
              merged: false,
              closed: false,
              commit: (
                await git(repository, ["ls-remote", "origin", `refs/heads/${metadata.headBranch}`])
              ).split(/\s/)[0]!,
            };
          },
        };
        const collectedHeads: string[] = [];
        const adapters = makeCodeAdapters(
          root,
          api,
          () => definition,
          async (receipt) => {
            collectedHeads.push(receipt.commit);
            return {
              url: receipt.url,
              commit: receipt.commit,
              collectedAt: "2026-09-16T00:00:00Z",
              body: "Review requests a regression test",
              unknowns: [],
            };
          },
        );
        const complete = (output: unknown) => {
          const action = run.actions.find((item) => item.status === "pending")!;
          run = decide(run, { type: "result", actionId: action.id, output }, definition, 1);
        };
        const code = Effect.fn(function* () {
          const action = run.actions.find((item) => item.status === "pending")!;
          const observation = yield* adapters[action.adapter]!.reconcile(
            action,
            run,
            () => Effect.void,
          );
          assert.equal(observation.status, "completed");
          if (observation.status === "completed") complete(observation.output);
          return { action, observation };
        });
        const report = (summary = "Fix the bug") =>
          complete({ summary, body: "Verified the fix", evidence: [], unknowns: [] });
        const decision = (choice: "approve" | "request_changes") => ({
          gateRevision: run.gate!.revision,
          artifactHash: run.gate!.artifactHash,
          decision: choice,
          feedback: choice === "request_changes" ? "Handle the edge case" : "",
          actor: "human",
        });
        run = decide(run, { type: "enter" }, definition, 1);
        yield* code();
        const workspace = run.artifacts[0]!.content as { worktree: string; branch: string };
        report(); // scout
        report(); // plan
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspace.worktree, "README.md"), "fixed\n"),
        );
        report(); // development
        yield* code(); // preparation
        assert.equal(run.phase, "pr-approval");
        const firstApproval = decision("approve");
        run = decide(
          run,
          { type: "decision", decision: decision("request_changes") },
          definition,
          1,
        );
        const developerAction = run.actions.find((action) => action.status === "pending")!;
        assert.include(
          (developerAction.input as { prompt: string }).prompt,
          "Handle the edge case",
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspace.worktree, "extra.txt"), "edge case\n"),
        );
        report("Fix with edge case");
        yield* code();
        assert.throws(
          () => decide(run, { type: "decision", decision: firstApproval }, definition, 1),
          /Gate or reviewed artifact has changed/,
        );
        const prepared = run.artifacts.findLast(
          (artifact) => artifact.phase === "prepare-publication",
        )!;
        const preparedContent = prepared.content as {
          diff: string;
          tree: string;
          title: string;
          body: string;
        };
        assert.include(preparedContent.diff, "extra.txt");
        assert.equal(preparedContent.title, "Fix with edge case");
        assert.include(preparedContent.body, "Verified the fix");
        const beforeEdit = decision("approve");
        run = decide(
          run,
          {
            type: "edit_gate",
            gateRevision: beforeEdit.gateRevision,
            artifactHash: beforeEdit.artifactHash,
            actor: "human",
            content: {
              commitMessage: "fix: edited message",
              title: "Edited title",
              body: "Edited body",
            },
          },
          definition,
          1,
        );
        assert.throws(
          () => decide(run, { type: "decision", decision: beforeEdit }, definition, 1),
          /Gate or reviewed artifact has changed/,
        );
        const edited = run.artifacts.findLast(
          (artifact) => artifact.phase === "prepare-publication",
        )!;
        assert.deepEqual(edited.content, {
          ...(prepared.content as object),
          commitMessage: "fix: edited message",
          title: "Edited title",
          body: "Edited body",
        });
        assert.equal((prepared.content as { title: string }).title, "Fix with edge case");
        const approvedRun = decide(
          run,
          { type: "decision", decision: decision("approve") },
          definition,
          1,
        );
        const commitAction = approvedRun.actions.find((item) => item.status === "pending")!;
        assert.include(
          (yield* adapters
            .custom_commit!.reconcile(
              commitAction,
              { ...approvedRun, approvals: [] },
              () => Effect.void,
            )
            .pipe(Effect.flip)).detail,
          "approval is missing",
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspace.worktree, "extra.txt"),
            "changed after approval\n",
          ),
        );
        assert.include(
          (yield* adapters
            .custom_commit!.reconcile(commitAction, approvedRun, () => Effect.void)
            .pipe(Effect.flip)).detail,
          "Approved code changed",
        );
        run = decide(
          approvedRun,
          { type: "invalidate", cause: "Candidate code changed" },
          definition,
          1,
        );
        assert.equal(run.status, "blocked");
        assert.equal(run.failureCategory, "candidate_changed");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspace.worktree, "extra.txt"), "edge case\n"),
        );
        run = approvedRun;
        for (let index = 0; index < 3; index++) {
          const { action, observation } = yield* code();
          assert.deepEqual(
            yield* adapters[action.adapter]!.reconcile(action, run, () => Effect.void),
            observation,
          );
        }
        assert.equal(run.status, reviewLoop ? "running" : "completed");
        assert.equal(creates, 1);
        assert.equal(
          yield* Effect.promise(() => git(workspace.worktree, ["log", "-1", "--format=%B"])),
          "fix: edited message",
        );
        assert.equal(
          yield* Effect.promise(() => git(workspace.worktree, ["rev-parse", "HEAD^"])),
          baseCommit,
        );
        assert.equal(
          yield* Effect.promise(() => git(workspace.worktree, ["status", "--porcelain"])),
          "",
        );
        if (reviewLoop) {
          const firstCommit = yield* Effect.promise(() =>
            git(workspace.worktree, ["rev-parse", "HEAD"]),
          );
          assert.equal(run.phase, "collect-feedback");
          yield* code();
          assert.equal(run.phase, "herald");
          assert.deepEqual(collectedHeads, [firstCommit]);
          report("Review requests a regression test");
          assert.equal(run.status, "waiting_approval");
          run = decide(
            run,
            { type: "decision", decision: decision("request_changes") },
            definition,
            1,
          );
          const nextBuilder = run.actions.findLast((item) => item.status === "pending")!;
          assert.include(
            (nextBuilder.input as { prompt: string }).prompt,
            "Review requests a regression test",
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(workspace.worktree, "regression.txt"), "tested\n"),
          );
          report("Add regression coverage");
          yield* code();
          assert.equal(run.phase, "pr-approval");
          assert.throws(
            () => decide(run, { type: "decision", decision: beforeEdit }, definition, 1),
            /Gate or reviewed artifact has changed/,
          );
          run = decide(run, { type: "decision", decision: decision("approve") }, definition, 1);
          for (let index = 0; index < 3; index++) {
            if (index === 1) {
              const pushAction = run.actions.findLast((item) => item.status === "pending")!;
              const ref = `refs/heads/${workspace.branch}`;
              yield* Effect.promise(() => git(remote, ["update-ref", ref, baseCommit]));
              assert.include(
                (yield* adapters
                  .custom_push!.reconcile(pushAction, run, () => Effect.void)
                  .pipe(Effect.flip)).detail,
                "Remote branch has an unexpected commit",
              );
              yield* Effect.promise(() => git(remote, ["update-ref", ref, firstCommit]));
            }
            const { action, observation } = yield* code();
            assert.deepEqual(
              yield* adapters[action.adapter]!.reconcile(action, run, () => Effect.void),
              observation,
            );
          }
          assert.equal(
            yield* Effect.promise(() => git(workspace.worktree, ["rev-parse", "HEAD^"])),
            firstCommit,
          );
          assert.equal(creates, 1);
          assert.equal(updates.at(-1), "Add regression coverage");
          const closedAdapters = makeCodeAdapters(
            root,
            {
              ...api,
              find: async (metadata) => {
                const current = await api.find(metadata);
                return current ? { ...current, closed: true } : null;
              },
            },
            () => definition,
          );
          const draftAction = run.actions.findLast((item) => item.adapter === "custom_draft")!;
          assert.include(
            (yield* closedAdapters
              .custom_draft!.reconcile(draftAction, run, () => Effect.void)
              .pipe(Effect.flip)).detail,
            "Draft PR does not match approval",
          );
          yield* code(); // collect feedback for the second published head
          assert.lengthOf(collectedHeads, 2);
          assert.notEqual(collectedHeads[0], collectedHeads[1]);
          report("All review feedback addressed");
          run = decide(run, { type: "decision", decision: decision("approve") }, definition, 1);
          assert.equal(run.status, "completed");
        }
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
);
