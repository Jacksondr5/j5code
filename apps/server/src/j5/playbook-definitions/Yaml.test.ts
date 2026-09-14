// @effect-diagnostics nodeBuiltinImport:off - fixture lives beside the test.
import type { Action, Decision, Run } from "@j5/playbook-contracts";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";

import { compileYamlPlaybook } from "./Yaml.ts";
import { development } from "./fh/development.ts";
import { hash } from "../playbook/Definition.ts";
import { testExecution } from "../playbook/testFixtures.ts";

const source = NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8");

it("compiles ordered phases and explicit shared agents", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  assert.equal(definition.id, "research-review");
  assert.deepEqual(
    definition.phases.map((phase) => phase.id),
    ["__workspace", "research", "review", "approval"],
  );
  assert.equal(definition.phases[1]!.tasks[0]!.agent, "researcher");
  assert.equal(definition.phases[2]!.tasks[0]!.agent, undefined);
  assert.equal(definition.agents?.researcher?.persona, "scout");
  assert.equal(definition.agents?.["inline:review:review-report"]?.persona, "critic");
});

it("binds named gate feedback into a later shared-agent turn", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  const decision = {
    gateRevision: 4,
    artifactHash: "gate-hash",
    decision: "request_changes",
    feedback: "Mention that the project is open source.",
    actor: "reviewer",
    phase: "approval",
  } satisfies Decision;
  const run = {
    id: "run",
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: definition.hash,
    squadronId: "squadron",
    projectId: "project",
    repository: "/test",
    baseCommit: "main",
    inputs: { request: "Summarize the README" },
    execution: {
      ...testExecution,
      personas: { ...testExecution.personas, researcher: testExecution.personas.scout },
    },
    phase: "research",
    revision: 5,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [],
    artifacts: [],
    approvals: [decision],
    visits: { research: 2 },
  } satisfies Run;
  const phase = definition.phases.find((item) => item.id === "research")!;
  const input = definition.input(run, phase, phase.tasks[0]!) as {
    prompt: string;
    selectedEvidenceHashes: readonly string[];
  };

  assert.include(input.prompt, decision.feedback);
  assert.deepEqual(input.selectedEvidenceHashes, [hash(decision)]);
});

it("loads Development YAML through its pinned compatibility implementation", () => {
  const yaml = NodeFS.readFileSync(new URL("./fh/development.yaml", import.meta.url), "utf8");
  const compiled = compileYamlPlaybook(yaml, "development.yaml", {
    "fh-development-v3": development,
  });
  assert.equal(compiled.hash, development.hash);
  assert.deepEqual(
    compiled.phases.map((phase) => phase.id),
    development.phases.map((phase) => phase.id),
  );
});

it("reports source files and fields for invalid references", () => {
  assert.throws(
    () => compileYamlPlaybook(source.replace("agent: researcher", "agent: missing"), "team.yaml"),
    /team\.yaml:phases\.research\.tasks\.investigate\.agent: unknown agent missing/,
  );
  assert.throws(
    () =>
      compileYamlPlaybook(source.replace("completed: review", "completed: nowhere"), "team.yaml"),
    /team\.yaml:phases: Error: Unknown transition nowhere/,
  );
});

it("maps registered code operations without permitting scripts", () => {
  const withValidation = source
    .replace("initial: research", "initial: verify")
    .replace(
      "phases:\n",
      "phases:\n  - id: verify\n    kind: code\n    tasks:\n      - id: validation\n        operation: validation\n    outcome: validation\n    transitions: { pass: research, revise: research }\n",
    );
  const definition = compileYamlPlaybook(withValidation, "operations.yaml");
  assert.equal(definition.phases[1]!.tasks[0]!.adapter, "validation");
  assert.notInclude(definition.source!, "executable:");
});

it("rejects scheduling the same shared conversation twice in one phase", () => {
  const duplicate = source.replace(
    "    outcome: completion",
    "      - id: investigate-again\n        agent: researcher\n        instructions: Check the research.\n        output: report\n    outcome: completion",
  );
  assert.throws(
    () => compileYamlPlaybook(duplicate, "team.yaml"),
    /Shared agent is scheduled twice/,
  );
});

it("validates corrected reviews against the originally scheduled evidence", () => {
  const definition = compileYamlPlaybook(source, "research-review.yaml");
  const subjectHash = "research-hash";
  const action = {
    id: "review-correction",
    runId: "run",
    phase: "review",
    revision: 3,
    task: "review-report",
    attempt: 2,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 1,
    resultArtifactId: null,
    input: {
      original: { selectedEvidenceHashes: [subjectHash] },
      correction: "Return valid JSON",
      output: "invalid",
    },
  } satisfies Action;

  assert.deepEqual(
    definition.validate(action, { verdict: "accept", subjectHash, findings: [] }, {} as Run),
    { verdict: "accept", subjectHash, findings: [] },
  );
});
