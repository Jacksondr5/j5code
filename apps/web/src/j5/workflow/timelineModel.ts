import type { TimelinePage } from "@j5/workflow-contracts/observability";

export type TimelineDisplayEntry = TimelinePage["revisions"][number]["entries"][number] & {
  readonly revision: number;
  readonly recordedAt: string | null;
};

export interface TimelineLane {
  readonly lane: "agent" | "code" | "gate" | "run";
  readonly label: string;
  readonly entries: readonly TimelineDisplayEntry[];
}

export const flattenTimeline = (pages: readonly TimelinePage[]): TimelineDisplayEntry[] => {
  const revisions = new Map<number, TimelinePage["revisions"][number]>();
  for (const page of pages)
    for (const revision of page.revisions) revisions.set(revision.revision, revision);
  return [...revisions.values()]
    .sort((left, right) => right.revision - left.revision)
    .flatMap((revision) =>
      revision.entries.map((entry) => ({
        ...entry,
        revision: revision.revision,
        recordedAt: revision.recordedAt,
        partial: revision.partial || entry.partial,
      })),
    );
};

const gateKind = new Set(["gate_opened", "gate_revised", "decision"]);
const actionKind = new Set([
  "action_queued",
  "action_correction",
  "action_completed",
  "action_failed",
]);

export function groupTimelineLanes(entries: readonly TimelineDisplayEntry[]): TimelineLane[] {
  const agents = new Map<string, TimelineDisplayEntry[]>();
  const code: TimelineDisplayEntry[] = [];
  const gate: TimelineDisplayEntry[] = [];
  const run: TimelineDisplayEntry[] = [];
  for (const entry of entries) {
    if (actionKind.has(entry.kind) && entry.actionKind === "agent") {
      const label = entry.task ?? "Agent";
      const lane = agents.get(label) ?? [];
      lane.push(entry);
      agents.set(label, lane);
    } else if (actionKind.has(entry.kind) && entry.actionKind === "code") {
      code.push(entry);
    } else if (
      gateKind.has(entry.kind) ||
      (entry.kind === "phase_entered" && entry.phase?.endsWith("_approval"))
    ) {
      gate.push(entry);
    } else {
      run.push(entry);
    }
  }
  return [
    ...[...agents].map(([label, laneEntries]) => ({
      lane: "agent" as const,
      label,
      entries: laneEntries,
    })),
    ...(code.length ? [{ lane: "code" as const, label: "Code", entries: code }] : []),
    ...(gate.length ? [{ lane: "gate" as const, label: "Human gate", entries: gate }] : []),
    ...(run.length ? [{ lane: "run" as const, label: "Workflow", entries: run }] : []),
  ];
}

export interface Dissent {
  readonly gateRevision: number;
  readonly phase: string | null;
  readonly reviewers: readonly string[];
  readonly overriddenBy: string | null;
}

export function detectDissent(entries: readonly TimelineDisplayEntry[]): Dissent[] {
  const chronological = [...entries].sort((left, right) => left.revision - right.revision);
  const results: Dissent[] = [];
  for (let index = 0; index < chronological.length; index += 1) {
    const entry = chronological[index];
    if (entry?.kind !== "action_completed" || entry.verdict !== "revise") continue;
    const reviewPhase = entry.phase ?? null;
    const following = chronological.slice(index + 1);
    const gate =
      following.find((candidate) => candidate.kind === "gate_opened") ??
      following.find(
        (candidate) => candidate.kind === "phase_entered" && candidate.phase?.endsWith("_approval"),
      );
    if (!gate) continue;
    const gateRevision = gate.gateRevision ?? gate.revision;
    const window = chronological.slice(chronological.indexOf(gate) + 1);
    const beforeReviewReturns = window.slice(
      0,
      window.findIndex(
        (candidate) => candidate.kind === "phase_entered" && candidate.phase === reviewPhase,
      ) === -1
        ? undefined
        : window.findIndex(
            (candidate) => candidate.kind === "phase_entered" && candidate.phase === reviewPhase,
          ),
    );
    const override = beforeReviewReturns.find(
      (candidate) =>
        candidate.kind === "decision" &&
        candidate.decision === "approve" &&
        candidate.gateRevision === gateRevision,
    );
    const existing = results.find((result) => result.gateRevision === gateRevision);
    const reviewer = entry.task ?? "Reviewer";
    if (existing) {
      if (!existing.reviewers.includes(reviewer)) (existing.reviewers as string[]).push(reviewer);
      continue;
    }
    results.push({
      gateRevision,
      phase: reviewPhase,
      reviewers: [reviewer],
      overriddenBy: override?.actor ?? null,
    });
  }
  return results;
}
