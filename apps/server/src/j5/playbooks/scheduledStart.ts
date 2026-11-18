import type { RunId, ThreadId } from "@t3tools/contracts";
import { PLAYBOOK_NAME_PATTERN, type PlaybookOrigin } from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readCaller } from "../../mcp/threadAccess.ts";
import { playbookError } from "./definition.ts";

// A bare name needs an instruction to use it. Ordinary prose can contain the same word.
const namedPlaybooks = (prompt: string) => {
  const names = new Set<string>();
  const before = "(?<![\\p{L}\\p{N}_:@/-])";
  const after = "(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_-])";
  const name = "([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\\.yaml)?";
  const quotedName = "[`'\"“]?" + name + "[`'\"”]?";
  const instruction = "(?:run|start|use|execute|launch)(?:\\s+the)?(?:\\s+playbook)?";
  const reference = `(?:@playbook:${name}|(?:/playbook|playbook(?:\\s+(?:named|called))?|${instruction})\\s+${quotedName}|${quotedName}\\s+playbook)`;
  const trimmed = prompt.trim().toLowerCase();
  if (PLAYBOOK_NAME_PATTERN.test(trimmed)) names.add(trimmed);
  for (const match of prompt.matchAll(new RegExp(before + reference + after, "giu"))) {
    const found = (match[1] ?? match[2] ?? match[3])?.toLowerCase();
    if (found !== undefined && PLAYBOOK_NAME_PATTERN.test(found)) names.add(found);
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
        `Include @playbook:${stem} or an instruction to run ${stem} in the configured schedule before starting it.`,
      );
  },
);

export const authorizePlaybookRevision = Effect.fn("Playbook.authorizeRevision")(function* () {
  if ((yield* readOrigin()).kind === "scheduled")
    return yield* playbookError(
      "scheduled_playbook_revision",
      "A person must request the revision in a new human turn.",
    );
});
