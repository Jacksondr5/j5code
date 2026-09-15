import type { ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import type { AgentPersonaDefinition } from "./agentPersonas.ts";

/**
 * Minimum contents of the built-in handoff artifacts. Custom artifact names a definition
 * declares get a generic checklist. These are prompt templates, not validators: the server
 * checks that the file exists, not what it says.
 */
export const AGENT_ARTIFACT_TEMPLATES: Readonly<Record<string, ReadonlyArray<string>>> = {
  ContextBrief: [
    "Request and bounded scope.",
    "Sources consulted, with stable citations or paths.",
    "Relevant facts separated from inference.",
    "Conflicts, missing evidence, and access limitations.",
    "Concise findings suitable for planning.",
  ],
  PlanHandoff: [
    "Objective, scope, and explicit non-goals.",
    "Product-sliced delivery tracks.",
    "Dependencies and sequencing constraints.",
    "Expected files or architectural boundaries.",
    "Validation strategy, risks, and unresolved decisions.",
  ],
  PlanCritique: [
    "Reviewer lens: advocate or skeptic.",
    "Finding list with evidence and severity.",
    "Covered, partial, missing, or contested items where applicable.",
    "Required revisions and non-blocking observations.",
    "Verdict: accept, revise, or blocked.",
  ],
  CodeCompleteHandoff: [
    "Governing handoff and implemented scope.",
    "Changed paths and behavior summary.",
    "Tests and checks run with results.",
    "Known limitations, residual risks, and unverified areas.",
    "Review-ready diff identity when available.",
    "Explicit statement that no commit or push was performed.",
  ],
  ReviewHandoff: [
    "Review lens: functional or security.",
    "Findings with severity, evidence, and affected paths.",
    "Validation performed.",
    "Fixes applied, only when the activation authorized them.",
    "Remaining findings and verdict.",
    "Explicit statement that no commit was performed.",
  ],
  PublicationReceipt: [
    "Branch and commit SHA or ordered commit SHAs.",
    "Conventional commit subjects.",
    "Push target and result.",
    "Pull request number and URL, and whether it was opened or updated.",
    "Checks or publication failures observed before handoff.",
    "Explicit merged: false assertion.",
  ],
  DiagnosisHandoff: [
    "Expected and observed behavior.",
    "Deterministic reproduction or the strongest bounded attempt.",
    "Failing boundary and causal mechanism supported by evidence.",
    "Alternatives considered and ruled out.",
    "Minimal fix sketch, without landing the fix.",
    "Confidence, limitations, and recommended validation.",
  ],
  DiagnosisCritique: [
    "Reproduction gaps or contradictions.",
    "Root-cause challenges and viable alternatives.",
    "Evidence quality and missing proof.",
    "Over-broad or unsafe repair concerns.",
    "Verdict: accept, revise, or blocked.",
  ],
  ReviewInbox: [
    "Review source and stable comment or thread identity.",
    "Blocking request, actionable non-blocker, or nit classification.",
    "Requested change mapped to relevant paths or lines when known.",
    "Duplicate, superseded, resolved, or still-open state.",
    "Ambiguities requiring human clarification.",
  ],
};

const GENERIC_TEMPLATE: ReadonlyArray<string> = [
  "What was asked and the scope you covered.",
  "What you found or produced, with evidence or paths.",
  "Open questions, risks, and anything you could not verify.",
];

export const AGENT_HANDOFF_ROOT = "handoffs";

const LEADING_HEX8 = /^[0-9a-f]{8}/i;

/**
 * The task segment of a handoff file name. Human-created threads have uuid ids, whose first
 * eight hex characters are readable and unique enough. Platform-spawned threads (crew seats,
 * spawned peers) have deterministic ids such as "thread:j5:a2a:mcp:…", which would all slice to
 * the same colon-bearing prefix, so those hash to eight hex characters instead.
 */
export function agentHandoffTaskSegment(threadId: string): string {
  return LEADING_HEX8.test(threadId)
    ? threadId.slice(0, 8)
    : NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 8);
}

/** One file per task, grouped by agent, so a reviewer's outputs sit together and nothing is overwritten. */
export function agentHandoffArtifactPath(input: {
  readonly personaId: string;
  readonly artifact: string;
  readonly threadId: ThreadId;
}): string {
  return `${AGENT_HANDOFF_ROOT}/${input.personaId}/${input.artifact}-${agentHandoffTaskSegment(input.threadId)}.md`;
}

/** The logical path agents see in chat and in the Artifacts panel. */
export const agentHandoffLogicalPath = (path: string) => `artifacts/${path}`;

/**
 * Instruction section appended to a persona's snapshot instructions when the definition
 * declares handoff artifacts. Written against the shared artifact tools, so the parent, a
 * Captain, or the user reads the result from the Artifacts panel rather than the transcript.
 */
export function agentPersonaArtifactInstructions(
  definition: Pick<AgentPersonaDefinition, "id" | "inputArtifacts" | "outputArtifact">,
  threadId: ThreadId,
): string | undefined {
  const inputs = definition.inputArtifacts ?? [];
  if (definition.outputArtifact === undefined && inputs.length === 0) return undefined;
  const lines = ["## Handoff artifacts"];
  if (inputs.length > 0) {
    lines.push(
      `Your inputs are ${inputs.map((name) => `\`${name}\``).join(", ")}. Look for them with \`list_artifacts\` under \`${AGENT_HANDOFF_ROOT}/\` (or use the artifact paths named in your task) and read them with \`read_artifact\` before you start.`,
    );
  }
  if (definition.outputArtifact !== undefined) {
    const path = agentHandoffArtifactPath({
      personaId: definition.id,
      artifact: definition.outputArtifact,
      threadId,
    });
    const template = AGENT_ARTIFACT_TEMPLATES[definition.outputArtifact] ?? GENERIC_TEMPLATE;
    lines.push(
      `Your output is a \`${definition.outputArtifact}\`. Before you finish, write it with \`write_artifact\` to exactly \`${path}\` as Markdown, then mention \`${agentHandoffLogicalPath(path)}\` in your final message. A task that ends without this file is not complete: the server checks for it, asks you once to write it, and otherwise marks the handoff missing.`,
      `The ${definition.outputArtifact} must contain:`,
      ...template.map((item) => `- ${item}`),
    );
  }
  return lines.join("\n");
}
