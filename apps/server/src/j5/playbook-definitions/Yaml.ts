import type { Action, Artifact, Run } from "@j5/playbook-contracts";
import {
  AgentPersonaAuthorityPolicy,
  type AgentPersonaAuthorityPolicy as Authority,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseDocument, stringify } from "yaml";

import {
  canonical,
  hash,
  selectedEvidenceHashes,
  validateDefinition,
  type Definition,
  type Phase,
} from "../playbook/Definition.ts";
import { readPlaybookExecution } from "../playbook/Execution.ts";
import { runtimeBuildHash } from "./manifest.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Agent = Schema.Struct({ persona: NonEmpty, authority: AgentPersonaAuthorityPolicy });
const Task = Schema.Struct({
  id: NonEmpty,
  agent: Schema.optional(NonEmpty),
  persona: Schema.optional(NonEmpty),
  authority: Schema.optional(AgentPersonaAuthorityPolicy),
  operation: Schema.optional(
    Schema.Literals([
      "workspace",
      "validation",
      "repair_capacity",
      "metadata",
      "commit",
      "push",
      "draft",
    ]),
  ),
  instructions: Schema.optional(NonEmpty),
  output: Schema.optional(Schema.Literals(["report", "review"])),
});
const PhaseSource = Schema.Struct({
  id: NonEmpty,
  label: Schema.optional(NonEmpty),
  kind: Schema.Literals(["agent", "code", "gate"]),
  tasks: Schema.optional(Schema.Array(Task)),
  visitLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  outcome: Schema.optional(Schema.Literals(["completion", "review", "validation"])),
  transitions: Schema.Record(NonEmpty, NonEmpty),
  evidence: Schema.optional(Schema.Array(NonEmpty)),
  approvals: Schema.optional(Schema.Array(NonEmpty)),
  capabilities: Schema.optional(Schema.Array(NonEmpty)),
});
export const YamlPlaybook = Schema.Struct({
  schema: Schema.Literal("t3-playbook/v1"),
  id: NonEmpty,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: NonEmpty,
  description: NonEmpty,
  implementation: Schema.optional(NonEmpty),
  initial: NonEmpty,
  agents: Schema.optional(Schema.Record(NonEmpty, Agent)),
  phases: Schema.Array(PhaseSource),
});
export type YamlPlaybook = typeof YamlPlaybook.Type;
const decodeYamlPlaybook = Schema.decodeUnknownSync(YamlPlaybook);

export class PlaybookDefinitionSourceError extends Error {
  readonly file: string;
  readonly field: string;
  constructor(file: string, field: string, message: string) {
    super(`${file}:${field}: ${message}`);
    this.file = file;
    this.field = field;
  }
}

const report = Schema.Struct({
  summary: NonEmpty,
  body: Schema.String,
  evidence: Schema.Array(Schema.String),
  unknowns: Schema.Array(Schema.String),
});
const review = Schema.Struct({
  verdict: Schema.Literals(["accept", "revise"]),
  subjectHash: NonEmpty,
  findings: Schema.Array(Schema.Struct({ blocking: Schema.Boolean, description: NonEmpty })),
});
const decodeReport = Schema.decodeUnknownSync(report);
const decodeReview = Schema.decodeUnknownSync(review);
const outputInstruction = {
  report:
    'Return ONLY one JSON object with {"summary":string,"body":string,"evidence":string[],"unknowns":string[]}.',
  review:
    'Return ONLY one JSON object with {"verdict":"accept"|"revise","subjectHash":string,"findings":{"blocking":boolean,"description":string}[]}.',
} as const;

function sourceValue(text: string, file: string): unknown {
  try {
    const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) throw issue;
    return document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new PlaybookDefinitionSourceError(file, "$", String(cause));
  }
}

const latest = (run: Run, phase: string) =>
  run.artifacts.findLast((artifact) => artifact.phase === phase);

/** Compile the deliberately small v1 authoring language into the existing pure engine. */
export function compileYamlPlaybook(
  text: string,
  file = "playbook.yaml",
  implementations: Readonly<Record<string, Definition>> = {},
): Definition {
  let source: YamlPlaybook;
  try {
    source = decodeYamlPlaybook(sourceValue(text, file));
  } catch (cause) {
    if (cause instanceof PlaybookDefinitionSourceError) throw cause;
    throw new PlaybookDefinitionSourceError(file, "$", String(cause));
  }
  if (source.phases.length === 0)
    throw new PlaybookDefinitionSourceError(file, "phases", "at least one phase is required");
  if (source.implementation) {
    const registered = implementations[source.implementation];
    if (!registered)
      throw new PlaybookDefinitionSourceError(
        file,
        "implementation",
        `unsupported implementation ${source.implementation}`,
      );
    if (registered.id !== source.id || registered.version !== source.version)
      throw new PlaybookDefinitionSourceError(
        file,
        "implementation",
        "registered implementation identity does not match the YAML definition",
      );
    return {
      ...registered,
      title: source.name,
      description: source.description,
      source: stringify(source, { sortMapEntries: true, lineWidth: 0 }),
      runtime: `${source.implementation}:${runtimeBuildHash}`,
      phases: registered.phases.map((phase) => {
        const label = source.phases.find((item) => item.id === phase.id)?.label;
        return { ...phase, ...(label === undefined ? {} : { label }) };
      }),
    };
  }
  const agents = source.agents ?? {};
  const assignments: Record<string, { persona: string; authority: Authority }> = { ...agents };
  for (const phase of source.phases)
    for (const task of phase.tasks ?? [])
      if (task.persona)
        assignments[`inline:${phase.id}:${task.id}`] = {
          persona: task.persona,
          authority: task.authority ?? "read-only",
        };
  const phases: Phase[] = [
    {
      id: "__workspace",
      kind: "code",
      tasks: [{ id: "workspace", adapter: "workspace" }],
      transitions: { pass: source.initial },
      maxVisits: 1,
    },
    ...source.phases.map((phase) => ({
      id: phase.id,
      ...(phase.label ? { label: phase.label } : {}),
      kind: phase.kind,
      tasks: (phase.tasks ?? []).map((task) => {
        if (phase.kind !== "agent")
          if (phase.kind === "gate")
            throw new PlaybookDefinitionSourceError(
              file,
              `phases.${phase.id}.tasks`,
              "gates cannot have tasks",
            );
          else {
            if (!task.operation || task.agent || task.persona)
              throw new PlaybookDefinitionSourceError(
                file,
                `phases.${phase.id}.tasks.${task.id}`,
                "code tasks require one registered operation",
              );
            return { id: task.id, adapter: task.operation };
          }
        if ((task.agent === undefined) === (task.persona === undefined))
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}`,
            "set exactly one of agent or persona",
          );
        if (task.agent && !agents[task.agent])
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}.agent`,
            `unknown agent ${task.agent}`,
          );
        if (!task.instructions || !task.output)
          throw new PlaybookDefinitionSourceError(
            file,
            `phases.${phase.id}.tasks.${task.id}`,
            "agent tasks require instructions and output",
          );
        return { id: task.id, adapter: "persona", ...(task.agent ? { agent: task.agent } : {}) };
      }),
      transitions: phase.transitions,
      maxVisits: phase.visitLimit ?? 1,
      ...(phase.capabilities ? { capabilities: phase.capabilities } : {}),
    })),
  ];
  const taskSource = (phaseId: string, taskId: string) =>
    source.phases.find((phase) => phase.id === phaseId)?.tasks?.find((task) => task.id === taskId);
  const canonicalSource = stringify(source, { sortMapEntries: true, lineWidth: 0 });
  const implementation = `yaml-runtime/v1:${runtimeBuildHash}`;
  const definition: Omit<Definition, "hash"> = {
    id: source.id,
    version: source.version,
    title: source.name,
    description: source.description,
    capabilities: [...new Set(source.phases.flatMap((phase) => phase.capabilities ?? []))],
    source: canonicalSource,
    runtime: implementation,
    agents: assignments,
    initial: "__workspace",
    phases,
    input: (run, phase, task) => {
      if (phase.id === "__workspace")
        return { inputs: run.inputs, selectedEvidenceIds: [], selectedEvidenceHashes: [] };
      const authored = taskSource(phase.id, task.id)!;
      const selected = (source.phases.find((item) => item.id === phase.id)?.evidence ?? [])
        .map((id) => latest(run, id))
        .filter((item): item is Artifact => item !== undefined);
      const decisions = run.approvals.filter((decision) =>
        (source.phases.find((item) => item.id === phase.id)?.approvals ?? []).includes(
          decision.phase ?? "",
        ),
      );
      if (phase.kind === "code")
        return {
          inputs: run.inputs,
          selectedEvidenceIds: [
            ...selected.map((item) => item.id),
            ...decisions.map((item) => `decision:${hash(item)}`),
          ],
          selectedEvidenceHashes: [...selected.map((item) => item.hash), ...decisions.map(hash)],
        };
      const assignmentKey = authored.agent ?? `inline:${phase.id}:${task.id}`;
      const personaId = authored.agent ? agents[authored.agent]!.persona : authored.persona!;
      const execution = readPlaybookExecution(run.execution);
      const assignment = execution.personas[assignmentKey];
      if (!assignment) throw new Error(`Missing persona snapshot ${assignmentKey}`);
      return {
        personaId,
        authorityPolicy: assignment.authorityPolicy,
        assignmentKey,
        assignmentDigest: assignment.definitionDigest,
        ...(authored.agent ? { sharedInstance: authored.agent } : {}),
        prompt: `${authored.instructions!}\n${outputInstruction[authored.output!]}\n${canonical({ request: run.inputs, evidence: selected, gateFeedback: decisions })}`,
        worktree: String(
          (latest(run, "__workspace")?.content as { worktree?: unknown } | undefined)?.worktree ??
            run.repository,
        ),
        branch: String(
          (latest(run, "__workspace")?.content as { branch?: unknown } | undefined)?.branch ??
            run.baseCommit,
        ),
        selectedEvidenceIds: [
          ...selected.map((item) => item.id),
          ...decisions.map((item) => `decision:${hash(item)}`),
        ],
        selectedEvidenceHashes: [...selected.map((item) => item.hash), ...decisions.map(hash)],
      };
    },
    validate: (action: Action, output: unknown) => {
      if (canonical(output).length > 131072) throw new Error("Output exceeds 128 KiB");
      if (action.phase === "__workspace") return output;
      const authored = taskSource(action.phase, action.task)!;
      if (action.kind === "code") return output;
      const decoded = authored.output === "review" ? decodeReview(output) : decodeReport(output);
      if (authored.output === "review") {
        const item = decoded as typeof review.Type;
        if ((item.verdict === "revise") !== item.findings.some((finding) => finding.blocking))
          throw new Error("Review verdict must match blocking findings");
        if (!selectedEvidenceHashes(action.input).includes(item.subjectHash))
          throw new Error("Review refers to evidence outside this action");
      }
      return decoded;
    },
    outcome: (_run, phase, artifacts) => {
      const rule = source.phases.find((item) => item.id === phase.id)?.outcome ?? "completion";
      if (rule === "review")
        return artifacts.some((artifact) => decodeReview(artifact.content).verdict === "revise")
          ? "revise"
          : "completed";
      if (rule === "validation")
        return (artifacts[0]?.content as { passed?: unknown } | undefined)?.passed
          ? "pass"
          : "revise";
      const operationOutcome = (artifacts[0]?.content as { outcome?: unknown } | undefined)
        ?.outcome;
      if (typeof operationOutcome === "string") return operationOutcome;
      return phase.kind === "code" ? "pass" : "completed";
    },
    gateArtifacts: (run, phase) => {
      const bindings = source.phases.find((item) => item.id === phase.id)?.evidence ?? [];
      return bindings.map((id) => latest(run, id)).filter((item): item is Artifact => !!item);
    },
  };
  const compiled = { ...definition, hash: hash([implementation, source]) };
  try {
    validateDefinition(compiled);
  } catch (cause) {
    throw new PlaybookDefinitionSourceError(file, "phases", String(cause));
  }
  return compiled;
}
