import type { RunId, ThreadId } from "@t3tools/contracts";
import { PLAYBOOK_NAME_PATTERN, type PlaybookOrigin } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readCaller } from "../../mcp/threadAccess.ts";
import { playbookError } from "./definition.ts";

// A configured schedule grants authority with an affirmative directive. A playbook name
// inside prose, a quoted example or a prohibition does not grant that authority.
const scheduledName = "([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\\.yaml)?";
const nameArgument = "(?:@playbook:|[`'\"“]?)" + scheduledName + "[`'\"”]?";
const scheduledDirective = new RegExp(
  "^(?:please\\s+)?(?:(?:run|start|use|execute|launch)\\s+(?:the\\s+)?(?:playbook\\s+(?:(?:named|called)\\s+)?)?|/playbook\\s+)" +
    nameArgument +
    "(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_-])",
  "iu",
);
const explicitMention = new RegExp("^@playbook:" + scheduledName + "$", "iu");
const namedPlaybooks = (prompt: string) => {
  const names = new Set<string>();
  const trimmed = prompt.trim().toLowerCase();
  if (PLAYBOOK_NAME_PATTERN.test(trimmed)) names.add(trimmed);
  let fence: string | undefined;
  for (const line of prompt.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t|\s*>)/u.test(line)) continue;
    for (const sentence of line.split(/(?<=[.!?;])\s+/u)) {
      const clause = sentence.trim().replace(/[.!?;]$/, "");
      const name = (scheduledDirective.exec(clause) ?? explicitMention.exec(clause))?.[1];
      if (name !== undefined) names.add(name.toLowerCase());
    }
  }
  return names;
};

const readOrigin = Effect.fn("Playbook.scheduledInputs")(function* () {
  const { caller, threads } = yield* readCaller();
  const unavailable = playbookError(
    "playbook_turn_unavailable",
    "The origin of this turn could not be verified. Request this operation in a new human turn.",
  );
  if (caller?.activeRunId == null) return yield* unavailable;

  // Follow the run that actually sent each input, including asynchronous peer deliveries.
  // A later independent human turn in the same thread starts with a fresh input.
  const pending: Array<{ threadId: ThreadId; runId: RunId; through: number }> = [
    { threadId: caller.id, runId: caller.activeRunId, through: Infinity },
  ];
  const visited = new Map<RunId, number>();
  let authorized: Set<string> | undefined;
  const restrict = (names: ReadonlySet<string>) => {
    if (authorized === undefined) authorized = new Set(names);
    else for (const name of authorized) if (!names.has(name)) authorized.delete(name);
  };
  while (pending.length > 0) {
    const { threadId, runId, through } = pending.pop()!;
    if ((visited.get(runId) ?? -Infinity) >= through) continue;
    visited.set(runId, through);
    const { runs, messages, thread } = yield* threads
      .getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageRunIds: [runId],
        messageRoles: ["user"],
      })
      .pipe(Effect.mapError(() => unavailable));
    const run = runs.find((record) => record.id === runId);
    const inputs = messages.filter((message) => message.runId === runId && message.role === "user");
    const origin = inputs.find((message) => message.id === run?.userMessageId);
    if (origin === undefined) return yield* unavailable;
    if (
      run?.ordinal === 1 &&
      thread.delegatedFrom !== undefined &&
      origin.createdBy !== "user" &&
      origin.playbookOrigin === undefined
    )
      return yield* unavailable;
    if (run?.restartContinuationOfRunId !== undefined)
      pending.push({ threadId, runId: run.restartContinuationOfRunId, through });
    for (const input of inputs) {
      const at = DateTime.toEpochMillis(input.createdAt);
      if (at > through) continue;
      if (
        input.createdBy !== "user" &&
        input.playbookOrigin === undefined &&
        input.scheduledTaskId === undefined &&
        input.senderThreadId === undefined &&
        input.delegatedCompletion === undefined &&
        run?.restartContinuationOfRunId === undefined
      )
        return yield* unavailable;
      if (input.delegatedCompletion !== undefined)
        pending.push({ threadId, runId: input.delegatedCompletion.parentRunId, through: at });
      if (input.scheduledTaskId !== undefined)
        restrict(namedPlaybooks(input.scheduledTaskPrompt ?? ""));
      if (input.playbookOrigin?.kind === "unverified") return yield* unavailable;
      if (input.playbookOrigin?.kind === "scheduled") restrict(new Set(input.playbookOrigin.names));
      if (
        input.senderThreadId !== undefined &&
        input.createdBy === "agent" &&
        input.playbookOrigin === undefined
      ) {
        if (input.senderRunId === undefined) return yield* unavailable;
        pending.push({ threadId: input.senderThreadId, runId: input.senderRunId, through: at });
      }
    }
  }
  return (
    authorized === undefined
      ? { kind: "unscheduled" }
      : { kind: "scheduled", names: [...authorized] }
  ) satisfies PlaybookOrigin;
});

/** Preserve the delivery itself when its provenance cannot be verified. */
export const handoffPlaybookOrigin = () =>
  readOrigin().pipe(Effect.orElseSucceed(() => ({ kind: "unverified" }) as const));

export const authorizeScheduledPlaybookStart = Effect.fn("Playbook.authorizeScheduledStart")(
  function* (name: string) {
    const stem = name.replace(/\.yaml$/, "");
    const origin = yield* readOrigin();
    if (origin.kind === "scheduled" && !origin.names.includes(stem))
      return yield* playbookError(
        "scheduled_playbook_not_named",
        `Ask a person to save the schedule in Settings with @playbook:${stem} on its own line or a directive such as “Run ${stem}.”`,
      );
    return origin;
  },
);

export const authorizePlaybookRevision = Effect.fn("Playbook.authorizeRevision")(function* () {
  if ((yield* readOrigin()).kind === "scheduled")
    return yield* playbookError(
      "scheduled_playbook_revision",
      "A person must request the revision in a new human turn.",
    );
});
