import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import type { AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import type { CrewProposal, CrewProposalSeat } from "./AgentCrewProposalService.ts";
import { formatRunFailureField } from "./runFailures.ts";

/**
 * How a seat's first turn went, measured from its run: `started` once provider activity is recorded
 * (or the run completed), `failed` when the run failed before the report, `pending`
 * when the report's window closed before either.
 */
export type SeatStartVerdict =
  | { readonly kind: "started" }
  | {
      readonly kind: "failed";
      readonly runId: string;
      readonly runStatus: string;
      readonly failure: OrchestrationV2ProviderFailure | null;
    }
  | { readonly kind: "pending" };

export interface CrewRosterChanges {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * What the person changed against the Captain's request: seats they added, dropped, or renamed on
 * the card. A rename is a dropped seat and an added seat that keep the same persona and reason.
 */
export const crewRosterChanges = (
  requested: ReadonlyArray<CrewProposalSeat>,
  approved: ReadonlyArray<CrewProposalSeat>,
): CrewRosterChanges => {
  const requestedNames = new Set(requested.map(({ seat }) => seat));
  const approvedNames = new Set(approved.map(({ seat }) => seat));
  const added = approved.filter(({ seat }) => !requestedNames.has(seat));
  const removed = requested.filter(({ seat }) => !approvedNames.has(seat));
  const renamed: Array<{ from: string; to: string }> = [];
  for (const gone of removed) {
    const twin = added.find(
      (seat) =>
        seat.agentId === gone.agentId &&
        seat.reason === gone.reason &&
        !renamed.some((pair) => pair.to === seat.seat),
    );
    if (twin !== undefined) renamed.push({ from: gone.seat, to: twin.seat });
  }
  const renamedFrom = new Set(renamed.map(({ from }) => from));
  const renamedTo = new Set(renamed.map(({ to }) => to));
  return {
    added: added.filter(({ seat }) => !renamedTo.has(seat)).map(({ seat }) => seat),
    removed: removed.filter(({ seat }) => !renamedFrom.has(seat)).map(({ seat }) => seat),
    renamed,
  };
};

const changesLine = (changes: CrewRosterChanges) => {
  const parts = [
    ...(changes.added.length > 0 ? [`added ${changes.added.join(", ")}`] : []),
    ...(changes.removed.length > 0 ? [`removed ${changes.removed.join(", ")}`] : []),
    ...changes.renamed.map(({ from, to }) => `renamed ${from}→${to}`),
  ];
  return parts.length === 0 ? "none" : parts.join("; ");
};

const head = (proposal: CrewProposal, decision: "approved" | "declined") =>
  `<j5_crew_gate>\nproposal_id: ${proposal.id}\nkind: ${proposal.kind}\ndecision: ${decision}\ncrew_name: ${proposal.displayName}`;

/** The platform-composed notice a Captain receives when the person declines: measured facts only. */
export const crewDeclinedNoticeText = (proposal: CrewProposal) =>
  `${head(proposal, "declined")}\nrequested_seats: ${proposal.requestedSeats.map(({ seat, agentId }) => `${seat}=${agentId ?? "custom"}`).join(", ")}\n</j5_crew_gate>\n\nThe user declined this crew request. Continue with the seats you have, or revise the request and propose again with a clearer reason.`;

/**
 * The launch report: the approval, what the person changed, and how each seat's first turn went.
 * Posted once every watched seat has a verdict or the window closed, so what it says is true when
 * the Captain reads it (Jackson's dogfood, 2026-09-17). Seats this proposal did not launch (the
 * rest of a Crew an addition joins) carry no `start`.
 */
export const crewLaunchReportText = (input: {
  readonly proposal: CrewProposal;
  readonly instance: AgentCrewInstance;
  readonly verdicts: ReadonlyMap<string, SeatStartVerdict>;
  readonly windowMs: number;
}) => {
  const { proposal, instance, verdicts } = input;
  const changes = crewRosterChanges(
    proposal.requestedSeats,
    proposal.approvedSeats ?? proposal.requestedSeats,
  );
  const started = [...verdicts].filter(([, verdict]) => verdict.kind === "started").length;
  const failed = [...verdicts].filter(([, verdict]) => verdict.kind === "failed");
  const pending = [...verdicts].filter(([, verdict]) => verdict.kind === "pending");
  const windowSeconds = Math.round(input.windowMs / 1000);
  const launch = `launch: ${started} started, ${failed.length} failed, ${pending.length} start unconfirmed after ${windowSeconds}s`;
  const failedLines = failed.map(
    ([seat, verdict]) =>
      `seat_failed: ${seat} | ${verdict.kind === "failed" ? verdict.runStatus : ""} | ${formatRunFailureField(verdict.kind === "failed" ? verdict.failure : null)}`,
  );
  const pendingLines = pending.map(([seat]) => `seat_pending: ${seat}`);
  const roster = instance.members
    .map((member) => {
      const verdict = verdicts.get(member.seatName);
      const isNew = member.addedVersion === instance.version && proposal.kind === "addition";
      return `- ${member.seatName}: participant_id=${member.participantId} agent=${member.agentId ?? "custom"} thread_id=${member.threadId}${
        verdict === undefined ? "" : ` start=${verdict.kind}`
      }${isNew ? " (new)" : ""}`;
    })
    .join("\n");
  const block = [
    head(proposal, "approved"),
    `crew_instance_id: ${instance.id}`,
    `crew_version: ${instance.version}`,
    `changes: ${changesLine(changes)}`,
    launch,
    ...failedLines,
    ...failed.flatMap(([, verdict]) =>
      verdict.kind === "failed" ? [`failed_run: ${verdict.runId}`] : [],
    ),
    ...pendingLines,
    `roster:\n${roster}`,
    "</j5_crew_gate>",
  ].join("\n");
  const prose: Array<string> = [];
  if (failed.length > 0)
    prose.push(
      `${failed.length} of ${verdicts.size} seats failed; each seat_failed line carries the run's error. The platform raises provider sign-in and permission failures in the human inbox. Re-brief the seat with send_message once the provider works; ask the user about other failures when their help is needed. Seats that started have your brief and this roster.`,
    );
  if (pending.length > 0)
    prose.push(
      `${pending.length} ${pending.length === 1 ? "seat has" : "seats have"} no confirmed provider activity after ${windowSeconds}s; its first turn may still be queued, and you will hear from it when it finishes.`,
    );
  if (failed.length === 0 && pending.length === 0)
    prose.push(
      "Your crew is running. Each seat has your brief and this roster; coordinate with send_message, and ask the user through the inbox for decisions you cannot make from the brief.",
    );
  return `${block}\n\n${prose.join(" ")}`;
};
