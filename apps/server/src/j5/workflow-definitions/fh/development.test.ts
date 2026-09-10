import { testExecution } from "../../workflow/testFixtures.ts";
// @effect-diagnostics nodeBuiltinImport:off schemaSyncInEffect:off - fixture callbacks validate known scripted artifacts synchronously.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Handoff from "@j5/workflow-contracts/fh";
import type { Action, Artifact, Run } from "@j5/workflow-contracts";
import { development, effectiveChecks, latest, selectAgentEvidence } from "./development.ts";
import { gateHash, hash } from "../../workflow/Definition.ts";
import {
  git,
  candidate,
  command,
  verificationEnvironment,
  publicationBaseBranch,
  resolveBase,
} from "./GitWorkspace.ts";
import { commit, push, draft, type GitHub } from "./Publication.ts";
import { makeCodeAdapters } from "./CodeAdapters.ts";
import { makeStore } from "../../workflow/Store.ts";
import { makeWorker, type Adapter } from "../../workflow/Worker.ts";
import { runWorkflowMigrations } from "../../workflow/Migrations.ts";
import { decide } from "../../workflow/decider.ts";

const decodePublication = Schema.decodeUnknownSync(Handoff.Publication);
const decodeReview = Schema.decodeUnknownSync(Handoff.ReviewHandoff);
const decodeValidation = Schema.decodeUnknownSync(Handoff.Validation);
const decodeWorkspace = Schema.decodeUnknownSync(Handoff.Workspace);

const workflowPhase = (id: string) => development.phases.find((phase) => phase.id === id)!;
const artifactsInTest = (run: Run, phase: string) =>
  run.artifacts.filter((artifact) => artifact.phase === phase);
const reviewArtifact = (
  id: string,
  verdict: "accept" | "revise",
  blocking: boolean,
  nonBlocking = false,
): Artifact => ({
  id,
  phase: "plan_review",
  content: {
    verdict,
    subjectHash: "plan-hash",
    findings: blocking
      ? [{ blocking: true, description: "Blocking finding" }]
      : nonBlocking
        ? [{ blocking: false, description: "Human may prefer another label" }]
        : [],
  },
  revision: 1,
  producer: id,
  attempt: 1,
  hash: id,
  governs: [],
});
const testRun = (visits: Run["visits"] = {}): Run => ({
  id: "definition-test",
  definitionId: development.id,
  definitionVersion: development.version,
  definitionHash: development.hash,
  squadronId: "s",
  projectId: "p",
  repository: "/repo",
  baseCommit: "base",
  inputs: { request: "change", baseRef: "main", evidence: [] },
  execution: testExecution,
  phase: "plan_review",
  revision: 1,
  status: "running",
  cause: null,
  recovery: null,
  gate: null,
  actions: [],
  artifacts: [
    {
      id: "plan",
      phase: "plan",
      content: { summary: "Plan", steps: ["Change code"], checks: [], assumptions: [] },
      revision: 1,
      producer: "navigator",
      attempt: 1,
      hash: "plan-hash",
      governs: [],
    },
    {
      id: "validation",
      phase: "validation",
      content: {
        codeIdentity: "code-identity",
        tree: "tree",
        passed: true,
        effectiveChecksHash: "checks-hash",
        correctionApproval: null,
        checks: [],
      },
      revision: 1,
      producer: "validation",
      attempt: 1,
      hash: "validation-hash",
      governs: [],
    },
  ],
  approvals: [],
  visits,
});
const reviewerAction = (task: "advocate" | "skeptic" | "critic" | "sentry"): Action => ({
  id: task,
  runId: "definition-test",
  phase: task === "advocate" || task === "skeptic" ? "plan_review" : "code_review",
  revision: 1,
  task,
  attempt: 1,
  kind: "agent",
  adapter: "persona",
  status: "completed",
  deadline: 1,
  input: {},
  resultArtifactId: null,
});
const reviewerTasks = ["advocate", "skeptic", "critic", "sentry"] as const;
const diagnosisAction: Action = {
  id: "diagnosis",
  runId: "definition-test",
  phase: "verification_diagnosis",
  revision: 2,
  task: "verification_diagnosis",
  attempt: 1,
  kind: "agent",
  adapter: "persona",
  status: "completed",
  deadline: 1,
  input: {},
  resultArtifactId: null,
};

const correctionRun = (): Run => {
  const run = testRun({ validation: 1, verification_diagnosis: 1 });
  const checks = [
    { executable: "vp", args: ["test", "--project", "unit"] },
    { executable: "vp", args: ["lint"] },
  ];
  return {
    ...run,
    phase: "verification_diagnosis",
    artifacts: run.artifacts.map((artifact) =>
      artifact.phase === "plan"
        ? {
            ...artifact,
            content: {
              summary: "Plan",
              steps: ["Change code"],
              checks,
              assumptions: [],
            },
          }
        : {
            ...artifact,
            content: {
              codeIdentity: "code-identity",
              tree: "tree",
              passed: false,
              effectiveChecksHash: hash(checks),
              correctionApproval: null,
              checks: [
                {
                  executable: "vp",
                  args: ["test", "--project", "unit"],
                  exitCode: 1,
                  output: "Unknown option --project",
                },
                { executable: "vp", args: ["lint"], exitCode: 0, output: "" },
              ],
            },
          },
    ),
  };
};

const correctionOutput = (run: Run) => ({
  planHash: latest(run, "plan").hash,
  failedValidationHash: latest(run, "validation").hash,
  explanation: "The root command names a project flag unsupported by this test runner",
  outcome: "check_correction" as const,
  corrections: [
    {
      originalIndex: 0,
      replacement: { executable: "vp", args: ["test", "packages/unit"] },
      repositoryEvidence: ["packages/unit/package.json defines the package-only test target"],
      verificationIntent: "Run the unit package tests",
    },
  ],
});

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

it("uses the project Node runtime for checks despite an older Node first on PATH", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-runtime-"));
  try {
    const oldBin = NodePath.join(root, "old-bin");
    await NodeFSP.mkdir(oldBin);
    await NodeFSP.writeFile(NodePath.join(oldBin, "node"), "#!/bin/sh\nexit 71\n", { mode: 0o755 });
    const vp = NodePath.join(root, "vp");
    await NodeFSP.writeFile(
      vp,
      `#!${process.execPath}\nconsole.log(JSON.stringify({node_path:process.execPath}));\n`,
      { mode: 0o755 },
    );
    const inherited = { ...process.env, PATH: `${oldBin}${NodePath.delimiter}${process.env.PATH}` };
    assert.equal((await command(root, "node", ["--version"], { env: inherited })).exitCode, 71);
    const env = await verificationEnvironment(root, [{ executable: vp }], inherited);
    const result = await command(root, "node", ["-p", "process.execPath"], { env });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), process.execPath);
    assert.equal(inherited.PATH.startsWith(oldBin), true);
    assert.strictEqual(
      await verificationEnvironment(root, [{ executable: "git" }], inherited),
      inherited,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

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
        definitionVersion: development.version,
        definitionHash: development.hash,
        squadronId: "s",
        projectId: "p",
        repository: f.repository,
        baseCommit: f.baseCommit,
        inputs: { request: "Add a correct value", baseRef: "main", evidence: [] },
        execution: testExecution,
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
                assumptions: [],
              };
            else if (action.task === "builder") {
              builds++;
              const ws = decodeWorkspace(latest(run, "workspace").content);
              await NodeFSP.writeFile(
                NodePath.join(ws.worktree, "value.txt"),
                builds === 1 ? "incorrect" : "correct",
              );
              output = { summary: "Add verified value", changes: ["value.txt"] };
            } else if (action.task === "verification_diagnosis") {
              output = {
                planHash: latest(run, "plan").hash,
                failedValidationHash: latest(run, "validation").hash,
                explanation: "The implementation wrote the wrong value",
                outcome: "implementation_repair",
                corrections: [],
              };
            } else if (action.phase === "plan_review")
              output = {
                verdict: "revise",
                findings: [{ blocking: true, description: "Prefer a different product choice" }],
                subjectHash: latest(run, "plan").hash,
              };
            else
              output = {
                verdict: "accept",
                findings: [],
                subjectHash: decodeValidation(latest(run, "validation").content).codeIdentity,
              };
            return { status: "completed" as const, output };
          }),
      };
      const adapters = { ...makeCodeAdapters(f.root, api), persona };
      yield* makeWorker(store, [development], adapters, "worker-1").drain(1);
      let run = yield* store.get(initial.id);
      assert.equal(run.phase, "plan_approval");
      assert.equal(run.status, "waiting_approval");
      assert.equal(run.visits.plan, 3);
      assert.equal(run.visits.plan_review, 3);
      const plan = latest(run, "plan");
      const dissentingReviews = run.artifacts
        .filter(
          (artifact) =>
            artifact.phase === "plan_review" &&
            decodeReview(artifact.content).subjectHash === plan.hash,
        )
        .slice(-2);
      assert.deepEqual(run.gate?.artifactIds, [
        plan.id,
        ...dissentingReviews.map((artifact) => artifact.id),
      ]);
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

it.effect(
  "diagnoses an invalid root package command, approves its correction, and reaches code review without another build",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(f.repository, "packages/unit"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(f.repository, "packages/unit/value.test.mjs"),
          "import assert from 'node:assert/strict'; import test from 'node:test'; import fs from 'node:fs'; test('value',()=>assert.equal(fs.readFileSync('value.txt','utf8'),'correct'));\n",
        );
        await git(f.repository, ["add", "packages/unit/value.test.mjs"]);
        await git(f.repository, ["commit", "-m", "add package-only test"]);
        f.baseCommit = await git(f.repository, ["rev-parse", "HEAD"]);
      });
      yield* runWorkflowMigrations();
      const store = yield* makeStore;
      const initial: Run = {
        id: "fh-check-correction",
        definitionId: development.id,
        definitionVersion: development.version,
        definitionHash: development.hash,
        squadronId: "s",
        projectId: "p",
        repository: f.repository,
        baseCommit: f.baseCommit,
        inputs: { request: "Add a correct value", baseRef: "main", evidence: [] },
        execution: testExecution,
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
          commandId: "start-correction",
          runId: initial.id,
          initial,
          event: { type: "enter" },
          expectedRevision: 0,
          now: 0,
        },
        development,
      );
      let builds = 0;
      const persona: Adapter = {
        recovery: "reconcile",
        interrupt: () => Effect.void,
        reconcile: (action, run) =>
          Effect.promise(async () => {
            if (action.task === "scout")
              return {
                status: "completed" as const,
                output: {
                  summary: "Node package test",
                  evidence: [
                    "packages/unit/value.test.mjs uses node:test from the repository root",
                  ],
                  unknowns: [],
                },
              };
            if (action.task === "navigator")
              return {
                status: "completed" as const,
                output: {
                  summary: "Add value",
                  steps: ["Write value.txt"],
                  checks: [
                    { executable: "node", args: ["--test", "--project", "packages/unit"] },
                    { executable: "node", args: ["-e", "process.exit(0)"] },
                  ],
                  assumptions: [],
                },
              };
            if (action.task === "builder") {
              builds++;
              const workspace = decodeWorkspace(latest(run, "workspace").content);
              await NodeFSP.writeFile(NodePath.join(workspace.worktree, "value.txt"), "correct");
              return {
                status: "completed" as const,
                output: { summary: "Add correct value", changes: ["value.txt"] },
              };
            }
            if (action.task === "verification_diagnosis")
              return {
                status: "completed" as const,
                output: {
                  planHash: latest(run, "plan").hash,
                  failedValidationHash: latest(run, "validation").hash,
                  explanation: "node --test does not accept the planned --project selector",
                  outcome: "check_correction",
                  corrections: [
                    {
                      originalIndex: 0,
                      replacement: {
                        executable: "node",
                        args: ["--test", "packages/unit/value.test.mjs"],
                      },
                      repositoryEvidence: ["packages/unit/value.test.mjs is the package test file"],
                      verificationIntent: "Run the package-only unit test",
                    },
                  ],
                },
              };
            return {
              status: "completed" as const,
              output: {
                verdict: "accept",
                findings: [],
                subjectHash:
                  action.phase === "plan_review"
                    ? latest(run, "plan").hash
                    : decodeValidation(latest(run, "validation").content).codeIdentity,
              },
            };
          }),
      };
      const adapters = { ...makeCodeAdapters(f.root), persona };
      yield* makeWorker(store, [development], adapters, "correction-worker").drain(1);
      let run = yield* store.get(initial.id);
      assert.equal(run.phase, "plan_approval");
      const decide = (current: Run, commandId: string, decision: "approve" | "request_changes") =>
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
                decision,
                feedback: decision === "request_changes" ? "Use the exact test file" : "",
                gateRevision: current.gate!.revision,
                artifactHash: current.gate!.artifactHash,
              },
            },
          },
          development,
        );
      yield* decide(run, "approve-correction-plan", "approve");
      yield* makeWorker(store, [development], adapters, "correction-worker").drain(3);
      run = yield* store.get(initial.id);
      assert.equal(run.phase, "checks_approval");
      assert.equal(run.status, "waiting_approval");
      assert.equal(builds, 1);
      assert.equal(run.visits.build, 1);
      assert.equal(artifactsInTest(run, "validation").length, 1);
      assert.notEqual(decodeValidation(latest(run, "validation").content).checks[0]!.exitCode, 0);
      yield* decide(run, "approve-corrected-check", "approve");
      yield* makeWorker(store, [development], adapters, "correction-worker").drain(4);
      run = yield* store.get(initial.id);
      assert.equal(run.phase, "publication_approval");
      assert.equal(run.status, "waiting_approval");
      assert.equal(builds, 1);
      const validation = decodeValidation(latest(run, "validation").content);
      assert.equal(validation.passed, true);
      assert.deepEqual(validation.checks[0]!.args, ["--test", "packages/unit/value.test.mjs"]);
      assert.deepEqual(validation.checks[1]!.args, ["-e", "process.exit(0)"]);
      assert.equal(
        validation.checks.every((check) => check.exitCode === 0),
        true,
      );
      assert.equal(validation.correctionApproval?.actor, "fixture-human");
      assert.equal(
        validation.effectiveChecksHash,
        hash([
          { executable: "node", args: ["--test", "packages/unit/value.test.mjs"] },
          { executable: "node", args: ["-e", "process.exit(0)"] },
        ]),
      );
      assert.equal(run.visits.code_review, 1);
      const metadata = decodePublication(latest(run, "metadata").content);
      assert.equal(metadata.effectiveChecksHash, validation.effectiveChecksHash);
      assert.deepEqual(metadata.correctionApproval, validation.correctionApproval);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.each([
  {
    name: "revises before either plan budget is exhausted",
    visits: { plan: 2, plan_review: 2 },
    expected: "revise",
  },
  {
    name: "escalates when both plan budgets are exhausted",
    visits: { plan: 3, plan_review: 3 },
    expected: "escalate",
  },
  {
    name: "escalates when the review budget is exhausted",
    visits: { plan: 2, plan_review: 3 },
    expected: "escalate",
  },
])("$name", ({ visits, expected }) => {
  const run = testRun(visits);
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "revise", true),
      reviewArtifact("skeptic", "revise", true),
    ]),
    expected,
  );
});

it("escalates a split plan review on the final round", () => {
  const run = testRun({ plan: 3, plan_review: 3 });
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "accept", false),
      reviewArtifact("skeptic", "revise", true),
    ]),
    "escalate",
  );
});

it.each([
  { name: "before the budget limit", visits: { plan: 2, plan_review: 2 } },
  { name: "at the budget limit", visits: { plan: 3, plan_review: 3 } },
])("passes two accepting plan reviews $name, including non-blocking findings", ({ visits }) => {
  const run = testRun(visits);
  assert.equal(
    development.outcome(run, workflowPhase("plan_review"), [
      reviewArtifact("advocate", "accept", false, true),
      reviewArtifact("skeptic", "accept", false),
    ]),
    "pass",
  );
});

it("revises rejected code reviews regardless of plan counters", () => {
  const run = testRun({ plan: 3, plan_review: 3 });
  assert.equal(
    development.outcome(run, workflowPhase("code_review"), [
      reviewArtifact("critic", "revise", true),
      reviewArtifact("sentry", "revise", true),
    ]),
    "revise",
  );
});

it.each(reviewerTasks)("rejects %s accepting a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.throws(
    () =>
      development.validate(
        reviewerAction(task),
        {
          verdict: "accept",
          subjectHash,
          findings: [{ blocking: true, description: "Blocking finding" }],
        },
        run,
      ),
    /verdict must match/,
  );
});

it.each(reviewerTasks)("rejects %s revising without a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.throws(
    () =>
      development.validate(
        reviewerAction(task),
        {
          verdict: "revise",
          subjectHash,
          findings: [{ blocking: false, description: "Preference" }],
        },
        run,
      ),
    /verdict must match/,
  );
});

it.each(reviewerTasks)("accepts %s revising with a blocking finding", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  assert.doesNotThrow(() =>
    development.validate(
      reviewerAction(task),
      {
        verdict: "revise",
        subjectHash,
        findings: [{ blocking: true, description: "Blocking finding" }],
      },
      run,
    ),
  );
});

it.each(reviewerTasks)("accepts %s accepting empty or non-blocking findings", (task) => {
  const run = testRun();
  const subjectHash = task === "advocate" || task === "skeptic" ? "plan-hash" : "code-identity";
  for (const findings of [[], [{ blocking: false, description: "Preference" }]]) {
    assert.doesNotThrow(() =>
      development.validate(reviewerAction(task), { verdict: "accept", subjectHash, findings }, run),
    );
  }
});

it("requires plans to record assumptions, including an empty list", () => {
  const decodePlan = Schema.decodeUnknownSync(Handoff.PlanHandoff);
  const plan = {
    summary: "Plan",
    steps: ["Change code"],
    checks: [{ executable: "vp", args: ["test"] }],
  };
  assert.doesNotThrow(() => decodePlan({ ...plan, assumptions: [] }));
  assert.throws(() => decodePlan(plan));
});

it("validates an indexed correction and applies it only after exact approval", () => {
  const run = correctionRun();
  const output = correctionOutput(run);
  const content = development.validate(diagnosisAction, output, run);
  const diagnosis: Artifact = {
    id: "diagnosis-artifact",
    phase: "verification_diagnosis",
    content,
    revision: 2,
    producer: "verification_diagnosis",
    attempt: 1,
    hash: "diagnosis-hash",
    governs: [],
  };
  assert.deepEqual(effectiveChecks(run).checks[0], {
    executable: "vp",
    args: ["test", "--project", "unit"],
  });
  const failed = latest(run, "validation");
  const approved: Run = {
    ...run,
    artifacts: [...run.artifacts, diagnosis],
    approvals: [
      {
        phase: "checks_approval",
        gateRevision: 9,
        artifactHash: gateHash([latest(run, "plan"), failed, diagnosis]),
        decision: "approve",
        feedback: "",
        actor: "human",
      },
    ],
  };
  const selected = effectiveChecks(approved);
  assert.deepEqual(selected.checks, [
    { executable: "vp", args: ["test", "packages/unit"] },
    { executable: "vp", args: ["lint"] },
  ]);
  assert.equal(selected.correction?.approval.gateRevision, 9);
});

it("uses the approved proposal revision and ignores an unapproved replacement", () => {
  const run = correctionRun();
  const proposal = (id: string, args: string[]): Artifact => ({
    id,
    phase: "verification_diagnosis",
    content: {
      ...correctionOutput(run),
      corrections: [
        {
          ...correctionOutput(run).corrections[0]!,
          replacement: { executable: "vp", args },
        },
      ],
    },
    revision: id === "proposal-1" ? 2 : 4,
    producer: "verification_diagnosis",
    attempt: 1,
    hash: id,
    governs: [],
  });
  const first = proposal("proposal-1", ["test", "wrong"]);
  const second = proposal("proposal-2", ["test", "packages/unit"]);
  const failed = latest(run, "validation");
  const approved: Run = {
    ...run,
    artifacts: [...run.artifacts, first, second],
    approvals: [
      {
        phase: "checks_approval",
        gateRevision: 5,
        artifactHash: gateHash([latest(run, "plan"), failed, second]),
        decision: "approve",
        feedback: "",
        actor: "human",
      },
    ],
  };
  assert.deepEqual(effectiveChecks(approved).checks[0], {
    executable: "vp",
    args: ["test", "packages/unit"],
  });
});

it.each([
  ["stale plan", (value: ReturnType<typeof correctionOutput>) => ({ ...value, planHash: "old" })],
  [
    "stale validation",
    (value: ReturnType<typeof correctionOutput>) => ({ ...value, failedValidationHash: "old" }),
  ],
  [
    "duplicate index",
    (value: ReturnType<typeof correctionOutput>) => ({
      ...value,
      corrections: [...value.corrections, value.corrections[0]!],
    }),
  ],
  [
    "invalid index",
    (value: ReturnType<typeof correctionOutput>) => ({
      ...value,
      corrections: [{ ...value.corrections[0]!, originalIndex: 8 }],
    }),
  ],
  [
    "unchanged replacement",
    (value: ReturnType<typeof correctionOutput>) => ({
      ...value,
      corrections: [
        {
          ...value.corrections[0]!,
          replacement: { executable: "vp", args: ["test", "--project", "unit"] },
        },
      ],
    }),
  ],
  [
    "passed check",
    (value: ReturnType<typeof correctionOutput>) => ({
      ...value,
      corrections: [{ ...value.corrections[0]!, originalIndex: 1 }],
    }),
  ],
])("rejects malformed correction proposal: %s", (_name, mutate) => {
  const run = correctionRun();
  assert.throws(() => development.validate(diagnosisAction, mutate(correctionOutput(run)), run));
});

it("rejects correction against validation that does not match the approved checks", () => {
  const run = correctionRun();
  const mismatched: Run = {
    ...run,
    artifacts: run.artifacts.map((artifact) =>
      artifact.phase === "validation"
        ? {
            ...artifact,
            content: {
              ...decodeValidation(artifact.content),
              effectiveChecksHash: hash([{ executable: "vp", args: ["test", "different"] }]),
            },
          }
        : artifact,
    ),
  };
  assert.throws(
    () => development.validate(diagnosisAction, correctionOutput(mismatched), mismatched),
    /does not match the approved plan checks/,
  );
});

it("bounds diagnosis, correction, build, and validation visits", () => {
  assert.equal(workflowPhase("build").maxVisits, 3);
  assert.equal(workflowPhase("validation").maxVisits, 4);
  assert.equal(workflowPhase("verification_diagnosis").maxVisits, 5);
  assert.equal(workflowPhase("checks_approval").maxVisits, 2);
  assert.equal(
    development.outcome(correctionRun(), workflowPhase("verification_diagnosis"), [
      {
        id: "environment",
        phase: "verification_diagnosis",
        content: {
          ...correctionOutput(correctionRun()),
          outcome: "environment_repair",
          corrections: [],
        },
        revision: 1,
        producer: "verification_diagnosis",
        attempt: 1,
        hash: "environment",
        governs: [],
      },
    ]),
    "environment_repair",
  );
});

it("rejects a third correction proposal version", () => {
  const run = correctionRun();
  const prior = ["first", "second"].map((id): Artifact => ({
    id,
    phase: "verification_diagnosis",
    content: correctionOutput(run),
    revision: 2,
    producer: "verification_diagnosis",
    attempt: 1,
    hash: id,
    governs: [],
  }));
  assert.throws(
    () =>
      development.validate(diagnosisAction, correctionOutput(run), {
        ...run,
        artifacts: [...run.artifacts, ...prior],
      }),
    /two-version correction proposal limit is exhausted/,
  );
});

it("rejects another correction after one proposal was approved", () => {
  const run = correctionRun();
  const diagnosis: Artifact = {
    id: "approved-diagnosis",
    phase: "verification_diagnosis",
    content: correctionOutput(run),
    revision: 2,
    producer: "verification_diagnosis",
    attempt: 1,
    hash: "approved-diagnosis",
    governs: [],
  };
  const approved: Run = {
    ...run,
    artifacts: [...run.artifacts, diagnosis],
    approvals: [
      {
        phase: "checks_approval",
        gateRevision: 3,
        artifactHash: gateHash([latest(run, "plan"), latest(run, "validation"), diagnosis]),
        decision: "approve",
        feedback: "",
        actor: "human",
      },
    ],
  };
  assert.throws(
    () => development.validate(diagnosisAction, correctionOutput(approved), approved),
    /Only one approved correction/,
  );
});

it("routes correction feedback to diagnosis, rejects stale approval, and preserves cancellation", () => {
  const base = correctionRun();
  const diagnosis: Artifact = {
    id: "gate-diagnosis",
    phase: "verification_diagnosis",
    content: correctionOutput(base),
    revision: 3,
    producer: "verification_diagnosis",
    attempt: 1,
    hash: "gate-diagnosis",
    governs: [],
  };
  const evidence = [latest(base, "plan"), latest(base, "validation"), diagnosis];
  const workspace: Artifact = {
    id: "feedback-workspace",
    phase: "workspace",
    content: { worktree: "/work", branch: "change", baseCommit: "base" },
    revision: 1,
    producer: "workspace",
    attempt: 1,
    hash: "feedback-workspace",
    governs: [],
  };
  const waiting: Run = {
    ...base,
    phase: "checks_approval",
    status: "waiting_approval",
    revision: 4,
    artifacts: [workspace, ...base.artifacts, diagnosis],
    gate: {
      revision: 4,
      artifactHash: gateHash(evidence),
      artifactIds: evidence.map(({ id }) => id),
    },
    visits: { checks_approval: 1, verification_diagnosis: 1 },
  };
  const decision = {
    actor: "human",
    gateRevision: 4,
    artifactHash: waiting.gate!.artifactHash,
    decision: "request_changes" as const,
    feedback: "Use the exact test file",
  };
  const revised = decide(waiting, { type: "decision", decision }, development, 10);
  assert.equal(revised.phase, "verification_diagnosis");
  assert.equal(revised.approvals.at(-1)?.feedback, "Use the exact test file");
  assert.throws(() =>
    decide(
      waiting,
      { type: "decision", decision: { ...decision, decision: "approve", gateRevision: 3 } },
      development,
      10,
    ),
  );
  const cancelled = decide(
    waiting,
    { type: "decision", decision: { ...decision, decision: "cancel", feedback: "" } },
    development,
    10,
  );
  assert.equal(cancelled.status, "cancelling");
  assert.equal(cancelled.approvals.at(-1)?.decision, "cancel");
});

it.effect("blocks a genuine repair when Builder capacity is exhausted", () =>
  Effect.gen(function* () {
    const run = correctionRun();
    const diagnosis: Artifact = {
      id: "dependency-diagnosis",
      phase: "verification_diagnosis",
      content: {
        ...correctionOutput(run),
        outcome: "environment_repair",
        corrections: [],
        explanation: "The package dependency installation is incomplete",
      },
      revision: 2,
      producer: "verification_diagnosis",
      attempt: 1,
      hash: "dependency-diagnosis",
      governs: [],
    };
    const blocked = yield* makeCodeAdapters("/tmp").repair_capacity!.reconcile(
      diagnosisAction,
      { ...run, artifacts: [...run.artifacts, diagnosis], visits: { build: 3, validation: 2 } },
      () => Effect.void,
    );
    assert.equal(blocked.status, "blocked");
    if (blocked.status === "blocked") assert.match(blocked.cause, /No Builder capacity remains/);
  }),
);

it.effect("blocks with retained evidence when diagnosis cannot repair the failure", () =>
  Effect.gen(function* () {
    const run = correctionRun();
    const diagnosis: Artifact = {
      id: "unable-diagnosis",
      phase: "verification_diagnosis",
      content: {
        ...correctionOutput(run),
        outcome: "unable_to_repair",
        corrections: [],
        explanation: "No repository evidence identifies a valid replacement",
      },
      revision: 2,
      producer: "verification_diagnosis",
      attempt: 1,
      hash: "unable-diagnosis",
      governs: [],
    };
    const blocked = yield* makeCodeAdapters("/tmp").verification_block!.reconcile(
      diagnosisAction,
      { ...run, artifacts: [...run.artifacts, diagnosis] },
      () => Effect.void,
    );
    assert.equal(blocked.status, "blocked");
    if (blocked.status === "blocked") assert.match(blocked.cause, /No repository evidence/);
  }),
);

it.effect("blocks a fourth validation without correction approval", () =>
  Effect.gen(function* () {
    const run = correctionRun();
    const plan = latest(run, "plan");
    const reviews = ["advocate", "skeptic"].map((producer): Artifact => ({
      id: producer,
      phase: "plan_review",
      content: { verdict: "accept", subjectHash: plan.hash, findings: [] },
      revision: 1,
      producer,
      attempt: 1,
      hash: producer,
      governs: [],
    }));
    const approved: Run = {
      ...run,
      visits: { validation: 4 },
      artifacts: [...run.artifacts, ...reviews],
      approvals: [
        {
          phase: "plan_approval",
          gateRevision: 2,
          artifactHash: gateHash([plan, ...reviews]),
          decision: "approve",
          feedback: "",
          actor: "human",
        },
      ],
    };
    const result = yield* makeCodeAdapters("/tmp").validation!.reconcile(
      diagnosisAction,
      approved,
      () => Effect.void,
    );
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.match(result.cause, /fourth validation/);
  }),
);

it.effect("invalidates an approved correction when candidate files change", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(f.repository, "value.txt"), "correct"),
    );
    const identity = yield* Effect.promise(() => candidate(f.repository, f.baseCommit));
    const base = correctionRun();
    const plan = latest(base, "plan");
    const reviews = ["advocate", "skeptic"].map((producer): Artifact => ({
      id: `candidate-${producer}`,
      phase: "plan_review",
      content: { verdict: "accept", subjectHash: plan.hash, findings: [] },
      revision: 1,
      producer,
      attempt: 1,
      hash: `candidate-${producer}`,
      governs: [],
    }));
    const workspace: Artifact = {
      id: "workspace",
      phase: "workspace",
      content: { worktree: f.repository, branch: "change", baseCommit: f.baseCommit },
      revision: 1,
      producer: "workspace",
      attempt: 1,
      hash: "workspace",
      governs: [],
    };
    const failed: Artifact = {
      ...latest(base, "validation"),
      content: { ...decodeValidation(latest(base, "validation").content), ...identity },
    };
    const diagnosis: Artifact = {
      id: "candidate-diagnosis",
      phase: "verification_diagnosis",
      content: { ...correctionOutput(base), failedValidationHash: failed.hash },
      revision: 3,
      producer: "verification_diagnosis",
      attempt: 1,
      hash: "candidate-diagnosis",
      governs: [],
    };
    const run: Run = {
      ...base,
      repository: f.repository,
      baseCommit: f.baseCommit,
      phase: "validation",
      visits: { validation: 2 },
      artifacts: [workspace, plan, ...reviews, failed, diagnosis],
      approvals: [
        {
          phase: "plan_approval",
          gateRevision: 2,
          artifactHash: gateHash([plan, ...reviews]),
          decision: "approve",
          feedback: "",
          actor: "human",
        },
        {
          phase: "checks_approval",
          gateRevision: 4,
          artifactHash: gateHash([plan, failed, diagnosis]),
          decision: "approve",
          feedback: "",
          actor: "human",
        },
      ],
    };
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(f.repository, "value.txt"), "changed"),
    );
    const result = yield* makeCodeAdapters(f.root).validation!.reconcile(
      diagnosisAction,
      run,
      () => Effect.void,
    );
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.failureCategory, "candidate_changed");
      assert.match(result.cause, /Candidate files changed/);
    }
  }),
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

it("resolves HEAD while preserving its tracked branch as the publication target", async () => {
  const f = await fixture();
  await git(f.repository, ["push", "-u", "origin", "main"]);
  assert.equal(await resolveBase(f.repository, " HEAD "), f.baseCommit);
  assert.equal(await publicationBaseBranch(f.repository, "HEAD"), "main");
});

it("reports an actionable error when the base ref is unavailable", async () => {
  const f = await fixture();
  assert.equal(
    await resolveBase(f.repository, "   ").catch(String),
    "Error: Enter a base ref before starting the workflow",
  );
  const error = await resolveBase(f.repository, "main-does-not-exist").catch(String);
  assert.match(error, /Base ref "main-does-not-exist" does not resolve to a commit/);
});

it("selects revision-related evidence and excludes superseded reviews", () => {
  const artifact = (id: string, phase: string, content: unknown, revision: number) => ({
    id,
    phase,
    content,
    revision,
    producer: phase,
    attempt: 1,
    hash: id,
    governs: [],
  });
  const run: Run = {
    id: "selection",
    definitionId: development.id,
    definitionVersion: development.version,
    definitionHash: development.hash,
    squadronId: "s",
    projectId: "p",
    repository: "/repo",
    baseCommit: "base",
    inputs: { request: "change", baseRef: "main", evidence: ["ticket:1"] },
    execution: testExecution,
    phase: "plan_review",
    revision: 12,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [],
    artifacts: [
      artifact(
        "workspace",
        "workspace",
        { worktree: "/work", branch: "change", baseCommit: "base" },
        1,
      ),
      artifact("context", "scout", { summary: "context" }, 2),
      artifact("plan-old", "plan", { summary: "old" }, 3),
      artifact(
        "old-review",
        "plan_review",
        { verdict: "revise", subjectHash: "plan-old", findings: [] },
        4,
      ),
      artifact("plan-current", "plan", { summary: "current" }, 6),
      artifact(
        "current-review",
        "plan_review",
        { verdict: "accept", subjectHash: "plan-current", findings: [] },
        7,
      ),
      artifact("build-old", "build", { summary: "old build" }, 8),
      artifact(
        "validation",
        "validation",
        {
          codeIdentity: "candidate",
          tree: "tree",
          passed: true,
          effectiveChecksHash: "checks-hash",
          correctionApproval: null,
          checks: [],
        },
        9,
      ),
      artifact(
        "unrelated-code-review",
        "code_review",
        { verdict: "accept", subjectHash: "other", findings: [] },
        10,
      ),
      artifact(
        "matching-code-review",
        "code_review",
        { verdict: "accept", subjectHash: "candidate", findings: [] },
        11,
      ),
    ],
    approvals: [
      {
        phase: "plan_approval",
        gateRevision: 5,
        artifactHash: "gate-1",
        decision: "request_changes",
        feedback: "first",
        actor: "human",
      },
      {
        phase: "plan_approval",
        gateRevision: 8,
        artifactHash: "gate-2",
        decision: "request_changes",
        feedback: "second",
        actor: "human",
      },
      {
        phase: "plan_approval",
        gateRevision: 10,
        artifactHash: "gate-3",
        decision: "approve",
        feedback: "",
        actor: "human",
      },
      {
        phase: "publication_approval",
        gateRevision: 12,
        artifactHash: "gate-4",
        decision: "request_changes",
        feedback: "adjust publication",
        actor: "human",
      },
    ],
    visits: {},
  };

  const navigator = selectAgentEvidence(run, "navigator");
  assert.deepEqual(
    navigator.artifacts.map(({ id }) => id),
    ["workspace", "context", "plan-current", "current-review"],
  );
  assert.deepEqual(
    navigator.decisions.map(({ feedback }) => feedback),
    ["first", "second"],
  );

  const builder = selectAgentEvidence(run, "builder");
  assert.includeMembers(
    builder.artifacts.map(({ id }) => id),
    ["plan-current", "build-old", "validation", "matching-code-review"],
  );
  assert.notInclude(
    builder.artifacts.map(({ id }) => id),
    "unrelated-code-review",
  );
  assert.deepEqual(
    builder.decisions.map(({ feedback }) => feedback),
    ["", "adjust publication"],
  );

  const critic = selectAgentEvidence(run, "critic");
  assert.deepEqual(
    critic.decisions.map(({ feedback }) => feedback),
    ["adjust publication"],
  );
});
